"""Benchmark harness for baseline/HSQ ablation (design 36-37, QNT-007).

Feeds the same fixture through every method and emits per-method
:class:`OnsetMetrics` so the quantizer's value can be measured, not assumed.
The arm vocabulary is the issue's:

* ``"B0"`` — nearest-sixteenth snap (:func:`snap_nearest_grid`);
* ``"B1"`` — nearest binary/triplet candidate-lattice snap
  (:func:`snap_candidate_lattice`);
* ``"B2"`` — optional ``music21.Stream.quantize`` baseline (skipped when
  music21 cannot be imported);
* ``"B3"`` — HSQ timing-only ablation: every notation-complexity weight
  zeroed (``symbol``/``tie``/``dots``/``tiny_rest``/boundary/tuplet/mode
  terms), so note ends follow onset/offset/IOI timing evidence alone —
  shows what the notation cost buys (design 37);
* ``"B4"`` — full HSQ-v1: the k-best onset DP with joint note/rest
  realization (rank-1 path of :func:`quantize_events`).

Ablation arms (``ABLATION_ARMS``) isolate single cost terms:

* ``"B4-no-ioi"`` — ``weights.ioi = 0``;
* ``"B4-no-tiny-rest"`` — ``weights.tiny_rest = 0``;
* ``"B4-no-mode-switch"`` — ``weights.mode_switch = 0``;
* ``"B3-no-ioi"`` — IOI removed inside the timing-only context, where it is
  the load-bearing term (in the realized context the notation cost can
  rescue the IOI pair on its own).

Baselines run on the unshifted normalization (``baseline_shift_sec = 0.0``
by default): compensating latency is part of what HSQ adds, so naive
baselines stay naive. They also emit provisional durations only — notation
complexity fields stay ``None`` for them (design 36.2 metrics apply to
realized output).
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Sequence
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

#: The five comparison arms required by the issue (design 37).
BASELINE_ARMS: tuple[str, ...] = ("B0", "B1", "B2", "B3", "B4")

#: Weight ablations (issue: no IOI, no notation complexity [= B3],
#: no tiny-rest penalty, no mode-switch penalty; ``B3-no-ioi`` isolates the
#: IOI term inside the timing-only context).
ABLATION_ARMS: tuple[str, ...] = (
    "B4-no-ioi",
    "B4-no-tiny-rest",
    "B4-no-mode-switch",
    "B3-no-ioi",
)

#: Every arm the standard benchmark run executes.
DEFAULT_ARMS: tuple[str, ...] = BASELINE_ARMS + ABLATION_ARMS


@dataclass(frozen=True)
class OnsetMetrics:
    """Per-method quality numbers for one fixture (design 36.1-36.2).

    Onset/duration fields are timing-space metrics (36.1); the
    ``*_count`` fields are the notation-complexity metrics (36.2) and stay
    ``None`` for methods that emit no realization (naive baselines).
    Rest-span and triplet-classification metrics are ``None`` unless the
    fixture declares the corresponding expectation.
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
    expected_rest_count: int | None = None
    """Rest spans the fixture declares (needs ``expected_rest_spans_ql``)."""
    rest_exact_count: int | None = None
    """Emitted rest spans exactly matching an expected ``(onset, duration)``."""
    rest_extra_count: int | None = None
    """Emitted rest spans matching no expected span."""
    rest_exact_rate: float | None = None
    """``rest_exact_count / max(expected_rest_count, 1)`` — rest correctness."""
    expected_tuplet_group_count: int | None = None
    """Visual triplet groups the fixture intends (triplet classification)."""
    triplet_false_positive_groups: int | None = None
    """Emitted tuplet groups beyond the expected count (false positives)."""
    triplet_missed_groups: int | None = None
    """Expected tuplet groups the method failed to emit (false negatives)."""
    review_issue_count: int | None = None
    """Internal review reasons raised (HSQ arms only; diagnostics-driven)."""
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
            "rest_exact_rate",
        ):
            value = getattr(self, name)
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError(f"{name} must be finite and >= 0, got {value!r}")
        if self.total_cost is not None and not math.isfinite(self.total_cost):
            raise ValueError(
                f"total_cost must be finite or None, got {self.total_cost!r}"
            )


@dataclass(frozen=True)
class MethodRun:
    """One method's benchmark result on one fixture, with wall-clock runtime.

    ``runtime_sec`` is the measured quantization time for the arm — the
    issue's runtime metric. It is intentionally kept out of
    :class:`OnsetMetrics` so the metrics stay exactly deterministic
    (``benchmark_onsets`` results compare equal across runs).
    """

    metrics: OnsetMetrics
    runtime_sec: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.runtime_sec) or self.runtime_sec < 0:
            raise ValueError(
                f"runtime_sec must be finite and >= 0, got {self.runtime_sec!r}"
            )


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
    expected_rest_spans_ql: Sequence[tuple[Fraction, Fraction]] | None = None,
    expected_tuplet_groups: int | None = None,
    rests: Sequence[RealizedRest] | None = None,
    diagnostics: QuantizationDiagnostics | None = None,
    total_cost: float | None = None,
) -> OnsetMetrics:
    """Compare emitted onsets/durations/rests to expected values, index-aligned.

    Positions pair by index (fixture order); extras on either side are
    counted via the counts/exact rate rather than penalized pairwise. When
    ``expected_durations_ql`` is given, duration accuracy is scored the same
    way on ``note.duration_ql``.

    When ``expected_rest_spans_ql`` is given (possibly empty), emitted
    ``RealizedRest`` spans ``(onset_ql, duration_ql)`` are compared as an
    exact multiset — a rest is correct only when both its position and its
    total span match (atom decomposition quality is covered by the
    complexity counts). Methods that emit no rests (naive baselines) score
    ``rest_exact_count = 0``.

    ``expected_tuplet_groups`` enables the triplet-classification metric:
    emitted ``tuplet_group_count`` is compared to the intent and the
    surplus/deficit is reported as false-positive/missed groups. It is
    ``None`` for methods without realization (a naive baseline cannot
    "commit" tuplets).

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

    emitted_rest_spans = tuple((r.onset_ql, r.duration_ql) for r in rests or ())
    expected_rest_count = rest_exact = rest_extra = rest_rate = None
    if expected_rest_spans_ql is not None:
        expected_spans = list(expected_rest_spans_ql)
        unmatched = list(emitted_rest_spans)
        exact = 0
        for span in expected_spans:
            if span in unmatched:
                unmatched.remove(span)
                exact += 1
        expected_rest_count = len(expected_spans)
        rest_exact = exact
        rest_extra = len(unmatched)
        # Empty expectation: perfect iff nothing was emitted (a spurious rest
        # against an empty expectation scores 0).
        rest_rate = (
            exact / len(expected_spans)
            if expected_spans
            else (1.0 if not unmatched else 0.0)
        )

    realized = rests is not None or any(n.notation is not None for n in quantized)
    counts: dict[str, int] = {}
    emitted_tuplet_groups: int | None = None
    review_count: int | None = None
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
        emitted_tuplet_groups = diagnostics.tuplet_group_count
        review_count = len(diagnostics.review_reasons)
    elif realized:
        note_atoms = [
            a for n in quantized if n.notation is not None for a in n.notation.atoms
        ]
        rest_atoms = [a for r in rests or () for a in r.notation.atoms]
        emitted_tuplet_groups = _atom_triplet_group_count(note_atoms + rest_atoms)
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
            "tuplet_group_count": emitted_tuplet_groups,
        }
    triplet_fp = triplet_missed = None
    if expected_tuplet_groups is not None and emitted_tuplet_groups is not None:
        triplet_fp = max(0, emitted_tuplet_groups - expected_tuplet_groups)
        triplet_missed = max(0, expected_tuplet_groups - emitted_tuplet_groups)
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
        expected_rest_count=expected_rest_count,
        rest_exact_count=rest_exact,
        rest_extra_count=rest_extra,
        rest_exact_rate=rest_rate,
        expected_tuplet_group_count=expected_tuplet_groups,
        triplet_false_positive_groups=triplet_fp,
        triplet_missed_groups=triplet_missed,
        review_issue_count=review_count,
        **counts,
    )


def _timing_only_weights(profile: QuantizationProfile) -> QuantizationProfile:
    """B3 profile: every notation-complexity weight zeroed (design 37).

    Realization stays enabled so output remains metrically comparable —
    note ends then follow onset/offset/IOI timing evidence alone.
    """
    return replace(
        profile,
        weights=replace(
            profile.weights,
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


def _arm_thunks(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    expected_onsets_ql: Sequence[Fraction],
    *,
    expected_durations_ql: Sequence[Fraction] | None,
    expected_rest_spans_ql: Sequence[tuple[Fraction, Fraction]] | None,
    expected_tuplet_groups: int | None,
    meter_map: MeterMap | None,
    profile: QuantizationProfile,
    baseline_shift_sec: float,
    arms: Sequence[str],
) -> list[tuple[str, Callable[[], OnsetMetrics]]]:
    """Build one zero-argument thunk per requested arm (shared by the
    deterministic and the timed entry points)."""
    normalized = onset_sorted(
        normalize_to_score_time(events, warp, alignment_shift_sec=baseline_shift_sec)
    )

    def hsq(
        name: str, run_profile: QuantizationProfile
    ) -> Callable[[], OnsetMetrics]:
        def run() -> OnsetMetrics:
            best = quantize_events(
                events, warp, meter_map, run_profile, search_alignment=True
            )
            return onset_metrics(
                name,
                best[0].notes if best else (),
                expected_onsets_ql,
                expected_durations_ql=expected_durations_ql,
                expected_rest_spans_ql=expected_rest_spans_ql,
                expected_tuplet_groups=expected_tuplet_groups,
                rests=best[0].rests if best else None,
                diagnostics=best[0].diagnostics if best else None,
                total_cost=best[0].total_cost if best else None,
            )

        return run

    def baseline(
        name: str, snap: Callable[[], tuple[QuantizedRhythmNote, ...]]
    ) -> Callable[[], OnsetMetrics]:
        def run() -> OnsetMetrics:
            return onset_metrics(
                name,
                snap(),
                expected_onsets_ql,
                expected_durations_ql=expected_durations_ql,
                expected_rest_spans_ql=expected_rest_spans_ql,
            )

        return run

    def music21_arm() -> OnsetMetrics:
        from hornscribe.rhythm.music21_baseline import quantize_with_music21

        return onset_metrics(
            "B2",
            quantize_with_music21(normalized, snap_grid_ql=profile.min_note_value_ql),
            expected_onsets_ql,
            expected_durations_ql=expected_durations_ql,
            expected_rest_spans_ql=expected_rest_spans_ql,
        )

    timing_only = _timing_only_weights(profile)
    builders: dict[str, Callable[[], OnsetMetrics]] = {
        "B0": baseline("B0", lambda: snap_nearest_grid(normalized)),
        "B1": baseline("B1", lambda: snap_candidate_lattice(normalized, profile)),
        "B2": music21_arm,
        "B3": hsq("B3", timing_only),
        "B4": hsq("B4", profile),
        "B4-no-ioi": hsq(
            "B4-no-ioi",
            replace(profile, weights=replace(profile.weights, ioi=0.0)),
        ),
        "B4-no-tiny-rest": hsq(
            "B4-no-tiny-rest",
            replace(profile, weights=replace(profile.weights, tiny_rest=0.0)),
        ),
        "B4-no-mode-switch": hsq(
            "B4-no-mode-switch",
            replace(profile, weights=replace(profile.weights, mode_switch=0.0)),
        ),
        "B3-no-ioi": hsq(
            "B3-no-ioi",
            replace(timing_only, weights=replace(timing_only.weights, ioi=0.0)),
        ),
    }
    unknown = [a for a in arms if a not in builders]
    if unknown:
        raise ValueError(f"unknown benchmark arms: {unknown}")
    return [(arm, builders[arm]) for arm in arms]


def benchmark_onsets(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    expected_onsets_ql: Sequence[Fraction],
    *,
    expected_durations_ql: Sequence[Fraction] | None = None,
    expected_rest_spans_ql: Sequence[tuple[Fraction, Fraction]] | None = None,
    expected_tuplet_groups: int | None = None,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    baseline_shift_sec: float = 0.0,
    arms: Sequence[str] = DEFAULT_ARMS,
) -> dict[str, OnsetMetrics]:
    """Run the requested arms on one fixture and emit deterministic metrics.

    Arm vocabulary is the issue's: ``B0`` nearest-16th, ``B1`` nearest
    binary/triplet lattice, ``B2`` music21 ``Stream.quantize``, ``B3`` HSQ
    timing-only, ``B4`` full HSQ-v1, plus the weight ablations in
    ``ABLATION_ARMS``. ``B2`` is skipped when music21 cannot be imported
    (optional baseline). Deterministic: same inputs always produce the same
    metrics table.

    Baselines normalize with ``baseline_shift_sec`` (default 0 = naive);
    HSQ arms perform their own alignment search inside
    :func:`quantize_events`. ``expected_durations_ql`` /
    ``expected_rest_spans_ql`` / ``expected_tuplet_groups`` (index-aligned
    with ``expected_onsets_ql`` where applicable) enable the duration, rest
    and triplet-classification metrics for every method.
    """
    thunks = _arm_thunks(
        events,
        warp,
        expected_onsets_ql,
        expected_durations_ql=expected_durations_ql,
        expected_rest_spans_ql=expected_rest_spans_ql,
        expected_tuplet_groups=expected_tuplet_groups,
        meter_map=meter_map,
        profile=profile
        if profile is not None
        else QuantizationProfile.standard(),
        baseline_shift_sec=baseline_shift_sec,
        arms=arms,
    )
    results: dict[str, OnsetMetrics] = {}
    for name, thunk in thunks:
        if name == "B2":
            try:
                results[name] = thunk()
            except ImportError:
                continue  # optional baseline: music21 unavailable
        else:
            results[name] = thunk()
    return results


def benchmark_methods(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    expected_onsets_ql: Sequence[Fraction],
    *,
    expected_durations_ql: Sequence[Fraction] | None = None,
    expected_rest_spans_ql: Sequence[tuple[Fraction, Fraction]] | None = None,
    expected_tuplet_groups: int | None = None,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    baseline_shift_sec: float = 0.0,
    arms: Sequence[str] = DEFAULT_ARMS,
) -> dict[str, MethodRun]:
    """Same arms as :func:`benchmark_onsets`, plus per-method wall-clock
    runtime — the committed-artifact variant (issue metrics: runtime).

    Runtime is measured with :func:`time.perf_counter` around each arm's
    full call, so HSQ arms include their alignment search. The quality
    metrics inside each :class:`MethodRun` are identical to
    :func:`benchmark_onsets` output for the same inputs.
    """
    thunks = _arm_thunks(
        events,
        warp,
        expected_onsets_ql,
        expected_durations_ql=expected_durations_ql,
        expected_rest_spans_ql=expected_rest_spans_ql,
        expected_tuplet_groups=expected_tuplet_groups,
        meter_map=meter_map,
        profile=profile
        if profile is not None
        else QuantizationProfile.standard(),
        baseline_shift_sec=baseline_shift_sec,
        arms=arms,
    )
    results: dict[str, MethodRun] = {}
    for name, thunk in thunks:
        if name == "B2":
            try:
                start = time.perf_counter()
                metrics = thunk()
                runtime = time.perf_counter() - start
            except ImportError:
                continue
        else:
            start = time.perf_counter()
            metrics = thunk()
            runtime = time.perf_counter() - start
        results[name] = MethodRun(metrics=metrics, runtime_sec=runtime)
    return results


__all__ = [
    "ABLATION_ARMS",
    "BASELINE_ARMS",
    "DEFAULT_ARMS",
    "MethodRun",
    "OnsetMetrics",
    "benchmark_methods",
    "benchmark_onsets",
    "onset_metrics",
]
