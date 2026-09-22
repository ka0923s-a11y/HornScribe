"""Benchmark harness for baseline/HSQ ablation (design 36-37).

Feeds the same fixture through every method and emits per-method
:class:`OnsetMetrics` so the quantizer's value can be measured, not assumed:

* ``"B0"`` — nearest-sixteenth snap (:func:`snap_nearest_grid`);
* ``"B1"`` — nearest candidate-lattice snap (:func:`snap_candidate_lattice`);
* ``"HSQ"`` — the k-best onset DP with joint note/rest realization
  (rank-1 path of :func:`quantize_events`);
* ``"HSQ-no-ioi"`` — same run with ``weights.ioi = 0``, the ablation
  proving the IOI term's contribution;
* ``"HSQ-timing"`` — same run with every notation-complexity weight zeroed
  (``symbol``/``tie``/``dots``/``tiny_rest``/boundary/tuplet/mode terms), so
  note ends follow offset timing evidence only — the timing-only ablation
  showing what the notation cost buys (design 37, B3-style);
* ``"music21"`` — optional B2 baseline (``include_music21``).

Baselines run on the unshifted normalization (``baseline_shift_sec = 0.0``
by default): compensating latency is part of what HSQ adds, so naive
baselines stay naive. They also emit provisional durations only — notation
complexity fields stay ``None`` for them (design 36.2 metrics apply to
realized output).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.rhythm._output import onset_sorted
from hornscribe.rhythm.baselines import snap_candidate_lattice, snap_nearest_grid
from hornscribe.rhythm.contracts import (
    QuantizationDiagnostics,
    QuantizedRhythmNote,
    RealizedRest,
    RhythmAtom,
)
from hornscribe.rhythm.meter import MeterMap
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.realize import TINY_REST_MAX_QL
from hornscribe.rhythm.timewarp import TimeWarp, normalize_to_score_time


@dataclass(frozen=True)
class OnsetMetrics:
    """Per-method quality numbers for one fixture (design 36.1-36.2).

    Onset/duration fields are timing-space metrics (36.1); the
    ``*_count`` fields are the notation-complexity metrics (36.2) and stay
    ``None`` for methods that emit no realization (naive baselines).
    """

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
    exact_duration_rate: float | None = None
    """Index-aligned exact notated-duration rate (needs
    ``expected_durations_ql``)."""
    mean_abs_duration_error_ql: float | None = None
    """Mean |notated - expected| duration over paired notes (ql)."""
    symbol_count: int | None = None
    tie_count: int | None = None
    rest_count: int | None = None
    tiny_rest_count: int | None = None
    second_dot_count: int | None = None
    strong_boundary_obscured_count: int | None = None
    tuplet_group_count: int | None = None
    """Visual tuplet groups committed (design 36.1 triplet metric)."""

    def __post_init__(self) -> None:
        for name in (
            "exact_onset_rate",
            "mean_abs_onset_error_ql",
            "max_abs_onset_error_ql",
            "exact_duration_rate",
            "mean_abs_duration_error_ql",
        ):
            value = getattr(self, name)
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError(f"{name} must be finite and >= 0, got {value!r}")
        if self.total_cost is not None and not math.isfinite(self.total_cost):
            raise ValueError(f"total_cost must be finite or None, got {self.total_cost!r}")


def _atom_triplet_group_count(atoms: Sequence[RhythmAtom]) -> int:
    """Contiguous triplet-atom runs — the atom-derived approximation of
    ``diagnostics.tuplet_group_count`` (positions are unavailable here, so
    a region-boundary split inside one contiguous run counts once)."""
    groups = 0
    in_group = False
    for atom in atoms:
        if atom.tuplet is not None:
            if not in_group:
                groups += 1
            in_group = True
        else:
            in_group = False
    return groups


def onset_metrics(
    method: str,
    quantized: Sequence[QuantizedRhythmNote],
    expected_onsets_ql: Sequence[Fraction],
    *,
    expected_durations_ql: Sequence[Fraction] | None = None,
    rests: Sequence[RealizedRest] | None = None,
    diagnostics: QuantizationDiagnostics | None = None,
    total_cost: float | None = None,
) -> OnsetMetrics:
    """Compare emitted onsets/durations to expected values, index-aligned.

    Positions pair by index (fixture order); extras on either side are
    counted via the counts/exact rate rather than penalized pairwise. When
    ``expected_durations_ql`` is given, duration accuracy is scored the same
    way on ``note.duration_ql``.

    Notation-complexity counts (design 36.2) come from ``diagnostics`` when
    given — they include non-atom-derivable data such as obscured-boundary
    counts — and otherwise from the emitted atoms when the method produced
    realizations (``rests`` and/or note ``notation``). Naive baselines pass
    neither and report ``None``.
    """
    expected = tuple(expected_onsets_ql)
    errors = [
        abs(float(note.onset_ql) - float(exp))
        for note, exp in zip(quantized, expected, strict=False)
    ]
    matched = sum(1 for e in errors if e == 0.0)
    positions = [note.onset_ql for note in quantized]
    monotonic = all(b > a for a, b in zip(positions, positions[1:], strict=False))

    duration_rate = duration_error = None
    if expected_durations_ql is not None:
        dur_errors = [
            abs(float(note.duration_ql) - float(exp))
            for note, exp in zip(quantized, expected_durations_ql, strict=False)
        ]
        duration_rate = (
            sum(1 for e in dur_errors if e == 0.0) / len(expected_durations_ql)
            if expected_durations_ql
            else 1.0
        )
        duration_error = sum(dur_errors) / len(dur_errors) if dur_errors else 0.0

    realized = rests is not None or any(n.notation is not None for n in quantized)
    counts: dict[str, int] = {}
    if diagnostics is not None:
        counts = {
            "symbol_count": diagnostics.symbol_count,
            "tie_count": diagnostics.tie_count,
            "rest_count": diagnostics.rest_count,
            "tiny_rest_count": diagnostics.tiny_rest_count,
            "second_dot_count": diagnostics.second_dot_count,
            "strong_boundary_obscured_count": (
                diagnostics.strong_boundary_obscured_count
            ),
            "tuplet_group_count": diagnostics.tuplet_group_count,
        }
    elif realized:
        note_atoms = [
            a for n in quantized if n.notation is not None for a in n.notation.atoms
        ]
        rest_atoms = [a for r in rests or () for a in r.notation.atoms]
        counts = {
            "symbol_count": len(note_atoms) + len(rest_atoms),
            "tie_count": sum(1 for a in note_atoms if a.tie_to_next),
            "rest_count": len(rest_atoms),
            "tiny_rest_count": sum(
                1 for a in rest_atoms if a.duration_ql < TINY_REST_MAX_QL
            ),
            "second_dot_count": sum(
                1 for a in note_atoms + rest_atoms if a.dots == 2
            ),
            "tuplet_group_count": _atom_triplet_group_count(
                note_atoms + rest_atoms
            ),
        }
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
        exact_duration_rate=duration_rate,
        mean_abs_duration_error_ql=duration_error,
        **counts,
    )


def benchmark_onsets(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    expected_onsets_ql: Sequence[Fraction],
    *,
    expected_durations_ql: Sequence[Fraction] | None = None,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    baseline_shift_sec: float = 0.0,
    include_ioi_ablation: bool = True,
    include_timing_ablation: bool = True,
    include_music21: bool = False,
) -> dict[str, OnsetMetrics]:
    """Run B0/B1/HSQ (+ ablations) on one fixture and emit metrics.

    Deterministic: same inputs always produce the same metrics table.
    Baselines normalize with ``baseline_shift_sec`` (default 0 = naive);
    HSQ performs its own alignment search inside :func:`quantize_events`.
    ``expected_durations_ql`` (index-aligned with ``expected_onsets_ql``)
    additionally enables duration accuracy metrics for every method.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    normalized = onset_sorted(
        normalize_to_score_time(events, warp, alignment_shift_sec=baseline_shift_sec)
    )
    results: dict[str, OnsetMetrics] = {}

    results["B0"] = onset_metrics(
        "B0",
        snap_nearest_grid(normalized),
        expected_onsets_ql,
        expected_durations_ql=expected_durations_ql,
    )
    results["B1"] = onset_metrics(
        "B1",
        snap_candidate_lattice(normalized, profile),
        expected_onsets_ql,
        expected_durations_ql=expected_durations_ql,
    )

    best = quantize_events(
        events, warp, meter_map, profile, search_alignment=True
    )
    results["HSQ"] = onset_metrics(
        "HSQ",
        best[0].notes if best else (),
        expected_onsets_ql,
        expected_durations_ql=expected_durations_ql,
        rests=best[0].rests if best else None,
        diagnostics=best[0].diagnostics if best else None,
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
            expected_durations_ql=expected_durations_ql,
            rests=ablated[0].rests if ablated else None,
            diagnostics=ablated[0].diagnostics if ablated else None,
            total_cost=ablated[0].total_cost if ablated else None,
        )

    if include_timing_ablation:
        # Timing-only ablation (design 37): realization stays on so the
        # output remains comparable, but every notation-complexity weight
        # is zeroed so note ends follow offset/IOI evidence alone.
        w = profile.weights
        timing_only_profile = replace(
            profile,
            weights=replace(
                w,
                symbol=0.0,
                tie=0.0,
                first_dot=0.0,
                second_dot=0.0,
                tuplet_group=0.0,
                tuplet_atom=0.0,
                mode_switch=0.0,
                tiny_rest=0.0,
                weak_boundary_crossing=0.0,
                strong_boundary_crossing=0.0,
            ),
        )
        timing = quantize_events(
            events, warp, meter_map, timing_only_profile, search_alignment=True
        )
        results["HSQ-timing"] = onset_metrics(
            "HSQ-timing",
            timing[0].notes if timing else (),
            expected_onsets_ql,
            expected_durations_ql=expected_durations_ql,
            rests=timing[0].rests if timing else None,
            diagnostics=timing[0].diagnostics if timing else None,
            total_cost=timing[0].total_cost if timing else None,
        )

    if include_music21:
        from hornscribe.rhythm.music21_baseline import quantize_with_music21

        results["music21"] = onset_metrics(
            "music21",
            quantize_with_music21(
                normalized, snap_grid_ql=profile.min_note_value_ql
            ),
            expected_onsets_ql,
            expected_durations_ql=expected_durations_ql,
        )

    return results


__all__ = ["OnsetMetrics", "benchmark_onsets", "onset_metrics"]
