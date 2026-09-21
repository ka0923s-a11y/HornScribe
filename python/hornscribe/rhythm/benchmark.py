"""Onset-metric benchmark harness for baseline/HSQ ablation (design 36-37).

Feeds the same fixture through every method and emits per-method
:class:`OnsetMetrics` so the quantizer's value can be measured, not assumed:

* ``"B0"`` — nearest-sixteenth snap (:func:`snap_nearest_grid`);
* ``"B1"`` — nearest candidate-lattice snap (:func:`snap_candidate_lattice`);
* ``"HSQ"`` — the k-best onset DP (rank-1 path of :func:`quantize_events`);
* ``"HSQ-no-ioi"`` — same run with ``weights.ioi = 0``, the timing-only
  ablation proving the IOI term's contribution;
* ``"music21"`` — optional B2 baseline (``include_music21``).

Baselines run on the unshifted normalization (``baseline_shift_sec = 0.0``
by default): compensating latency is part of what HSQ adds, so naive
baselines stay naive.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.rhythm._output import onset_sorted
from hornscribe.rhythm.baselines import snap_candidate_lattice, snap_nearest_grid
from hornscribe.rhythm.contracts import QuantizedRhythmNote
from hornscribe.rhythm.meter import MeterMap
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.timewarp import TimeWarp, normalize_to_score_time


@dataclass(frozen=True)
class OnsetMetrics:
    """Per-method onset quality numbers for one fixture (design 36.1)."""

    method: str
    note_count: int
    """Quantized notes emitted by the method."""
    expected_count: int
    """Ground-truth onsets in the fixture."""
    matched_count: int
    """Positions equal to the expected onset at the same index."""
    exact_onset_rate: float
    """``matched_count / expected_count`` in [0, 1]."""
    mean_abs_onset_error_ql: float
    """Mean |quantized - expected| over paired positions (ql)."""
    max_abs_onset_error_ql: float
    """Max |quantized - expected| over paired positions (ql)."""
    monotonic: bool
    """True iff emitted onsets are strictly increasing (output contract)."""
    total_cost: float | None = None
    """HSQ objective cost when available (``None`` for baselines)."""

    def __post_init__(self) -> None:
        for name in (
            "exact_onset_rate",
            "mean_abs_onset_error_ql",
            "max_abs_onset_error_ql",
        ):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and >= 0, got {value!r}")
        if self.total_cost is not None and not math.isfinite(self.total_cost):
            raise ValueError(f"total_cost must be finite or None, got {self.total_cost!r}")


def onset_metrics(
    method: str,
    quantized: Sequence[QuantizedRhythmNote],
    expected_onsets_ql: Sequence[Fraction],
    *,
    total_cost: float | None = None,
) -> OnsetMetrics:
    """Compare emitted onsets to expected grid positions, index-aligned.

    Positions pair by index (fixture order); extras on either side are
    counted via the counts/exact rate rather than penalized pairwise.
    """
    expected = tuple(expected_onsets_ql)
    errors = [
        abs(float(note.onset_ql) - float(exp))
        for note, exp in zip(quantized, expected, strict=False)
    ]
    matched = sum(1 for e in errors if e == 0.0)
    positions = [note.onset_ql for note in quantized]
    monotonic = all(b > a for a, b in zip(positions, positions[1:], strict=False))
    return OnsetMetrics(
        method=method,
        note_count=len(quantized),
        expected_count=len(expected),
        matched_count=matched,
        exact_onset_rate=matched / len(expected) if expected else 1.0,
        mean_abs_onset_error_ql=sum(errors) / len(errors) if errors else 0.0,
        max_abs_onset_error_ql=max(errors) if errors else 0.0,
        monotonic=monotonic,
        total_cost=total_cost,
    )


def benchmark_onsets(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    expected_onsets_ql: Sequence[Fraction],
    *,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    baseline_shift_sec: float = 0.0,
    include_ioi_ablation: bool = True,
    include_music21: bool = False,
) -> dict[str, OnsetMetrics]:
    """Run B0/B1/HSQ (+ ablations) on one fixture and emit onset metrics.

    Deterministic: same inputs always produce the same metrics table.
    Baselines normalize with ``baseline_shift_sec`` (default 0 = naive);
    HSQ performs its own alignment search inside :func:`quantize_events`.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    normalized = onset_sorted(
        normalize_to_score_time(events, warp, alignment_shift_sec=baseline_shift_sec)
    )
    results: dict[str, OnsetMetrics] = {}

    results["B0"] = onset_metrics("B0", snap_nearest_grid(normalized), expected_onsets_ql)
    results["B1"] = onset_metrics(
        "B1", snap_candidate_lattice(normalized, profile), expected_onsets_ql
    )

    best = quantize_events(
        events, warp, meter_map, profile, search_alignment=True
    )
    results["HSQ"] = onset_metrics(
        "HSQ",
        best[0].notes if best else (),
        expected_onsets_ql,
        total_cost=best[0].total_cost if best else None,
    )

    if include_ioi_ablation:
        no_ioi_profile = replace(
            profile, weights=replace(profile.weights, ioi=0.0)
        )
        ablated = quantize_events(
            events, warp, meter_map, no_ioi_profile, search_alignment=True
        )
        results["HSQ-no-ioi"] = onset_metrics(
            "HSQ-no-ioi",
            ablated[0].notes if ablated else (),
            expected_onsets_ql,
            total_cost=ablated[0].total_cost if ablated else None,
        )

    if include_music21:
        from hornscribe.rhythm.music21_baseline import quantize_with_music21

        results["music21"] = onset_metrics(
            "music21",
            quantize_with_music21(
                normalized, snap_grid_ql=profile.min_note_value_ql
            ),
            expected_onsets_ql,
        )

    return results


__all__ = ["OnsetMetrics", "benchmark_onsets", "onset_metrics"]
