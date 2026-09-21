"""HSQ-v1 onset quantizer (QNT-002; QUANTIZER_DESIGN.md 11, 19, 32, 44).

Pipeline implemented here (design 32):

1. ``normalize`` — raw events pass through the :class:`TimeWarp` into float
   quarterLength (:func:`hornscribe.rhythm.normalize_to_score_time`);
   a global alignment shift ``delta_sec`` compensating AMT/beat latency is
   searched *before* this step (design 6.3);
2. ``candidates`` — per-note binary lattice inside the candidate window
   (design 8, :mod:`hornscribe.rhythm.lattice`);
3. ``DP`` — deterministic top-K monotonic onset search over Huber onset
   cost + IOI cost (design 9-11, :mod:`hornscribe.rhythm.dp`);
4. alternatives — up to ``k_best`` ranked :class:`QuantizationAlternative`
   objects (design 19), with review reasons surfaced through
   :class:`QuantizationDiagnostics` (design 40-41).

Deliberately absent at this phase (issue non-goals): rests, ties, tuplets,
joint duration realization — note durations are provisional spans to the
next onset (see :mod:`hornscribe.rhythm._output`), and raw event durations
are never mutated.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.rhythm._output import (
    assemble_quantized_notes,
    monotonic_positions,
    onset_sorted,
)
from hornscribe.rhythm.contracts import (
    NormalizedNote,
    QuantizationAlternative,
    QuantizationDiagnostics,
)
from hornscribe.rhythm.costs import confidence_weight, huber
from hornscribe.rhythm.dp import OnsetPath, evaluate_onset_path_cost, kbest_onset_paths
from hornscribe.rhythm.lattice import (
    generate_onset_candidates,
    grid_distance_ql,
    snap_to_grid_ql,
)
from hornscribe.rhythm.meter import MeterMap, MeterSegment
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.timewarp import TimeWarp, normalize_to_score_time

#: Coarse alignment-shift search step (design 6.3: ±120 ms band).
ALIGNMENT_COARSE_STEP_SEC = 0.005
#: Refinement step around the coarse winner.
ALIGNMENT_FINE_STEP_SEC = 0.001
#: Per-note cost margin below which rank-2 counts as ambiguous (design 20).
AMBIGUITY_MARGIN_PER_NOTE = 0.15
#: Relative tolerance for competing local minima in the shift surface (6.3).
ALIGNMENT_COMPETING_MIN_REL = 0.05


@dataclass(frozen=True)
class AlignmentEstimate:
    """Result of the global latency/alignment shift search (design 6.3).

    ``shift_sec`` is added to raw event seconds before normalization; a
    *late* AMT therefore reports a negative shift. ``uncertain`` is set when
    the search should not be trusted silently: the winner sits at the search
    band edge (true latency may exceed the band) or a competing local
    minimum is within tolerance — both surface as
    ``"beat_alignment_uncertain"`` review reasons by the caller.
    """

    shift_sec: float
    score: float
    """Total confidence-weighted metrical Huber residual at the winner."""
    band_edge: bool
    competing_minima: int
    """Local minima other than the winner within the relative tolerance."""

    @property
    def uncertain(self) -> bool:
        return self.band_edge or self.competing_minima > 0


def _default_meter_map() -> MeterMap:
    """4/4 from position 0 — the fixed-BPM MVP default (design 28)."""
    return MeterMap((MeterSegment(Fraction(0), 4, 4),))


def estimate_alignment_shift(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    profile: QuantizationProfile,
    *,
    coarse_step_sec: float = ALIGNMENT_COARSE_STEP_SEC,
    fine_step_sec: float = ALIGNMENT_FINE_STEP_SEC,
) -> AlignmentEstimate:
    """Estimate the global seconds shift minimizing metrical distance (6.3).

    Score for a candidate shift ``delta`` is the confidence-weighted Huber
    distance of every onset to the nearest grid point *after* warping —
    ``sum_i w_i * Huber(dist_grid(W(t_i + delta)) / sigma_onset)``. IOI terms
    are shift-invariant and intentionally absent from the proxy.

    Search: a deterministic coarse grid over
    ``[-max_alignment_shift_sec, +max_alignment_shift_sec]`` followed by a
    fine pass around the winner. Ties prefer the shift closest to zero,
    then the smaller value — no randomness.
    """
    events = tuple(events)
    if not events or profile.max_alignment_shift_sec <= 0:
        return AlignmentEstimate(shift_sec=0.0, score=0.0, band_edge=False, competing_minima=0)
    if coarse_step_sec <= 0 or fine_step_sec <= 0 or fine_step_sec > coarse_step_sec:
        raise ValueError("need 0 < fine_step_sec <= coarse_step_sec")

    onsets = tuple(e.onset_sec for e in events)
    weights = tuple(confidence_weight(e.confidence) for e in events)
    step_ql = profile.min_note_value_ql
    sigma = profile.sigma_onset_ql
    k = profile.huber_k
    band = profile.max_alignment_shift_sec

    def score(delta_sec: float) -> float:
        total = 0.0
        for t, w in zip(onsets, weights, strict=True):
            x = float(warp.seconds_to_ql(t + delta_sec))
            total += w * huber(grid_distance_ql(x, step_ql) / sigma, k)
        return total

    def search(lo: float, hi: float, step: float) -> tuple[float, float]:
        """Minimize score over a uniform grid; deterministic tie-break."""
        n = max(1, int(round((hi - lo) / step)))
        deltas = [lo + i * step for i in range(n + 1)]
        best = min(deltas, key=lambda d: (score(d), abs(d), d))
        return best, score(best)

    coarse_best, _ = search(-band, band, coarse_step_sec)
    fine_lo = max(-band, coarse_best - coarse_step_sec)
    fine_hi = min(band, coarse_best + coarse_step_sec)
    best, best_score = search(fine_lo, fine_hi, fine_step_sec)

    # Competing local minima on the coarse grid (design 6.3 multi-peak rule).
    n_coarse = max(1, int(round(2 * band / coarse_step_sec)))
    coarse_deltas = [-band + i * coarse_step_sec for i in range(n_coarse + 1)]
    coarse_scores = [score(d) for d in coarse_deltas]
    margin = best_score * ALIGNMENT_COMPETING_MIN_REL + 1e-9
    competing = 0
    for i in range(1, len(coarse_deltas) - 1):
        s = coarse_scores[i]
        is_local_min = s < coarse_scores[i - 1] and s <= coarse_scores[i + 1]
        if (
            is_local_min
            and abs(coarse_deltas[i] - best) > fine_step_sec
            and s <= best_score + margin
        ):
            competing += 1

    band_edge = abs(abs(best) - band) <= fine_step_sec
    return AlignmentEstimate(
        shift_sec=best, score=best_score, band_edge=band_edge, competing_minima=competing
    )


def _review_reasons(
    paths: tuple[OnsetPath, ...], note_count: int, alignment_uncertain: bool
) -> tuple[str, ...]:
    """Internal review reason strings for diagnostics (design 40)."""
    reasons: list[str] = []
    if len(paths) >= 2:
        margin = (paths[1].cost - paths[0].cost) / max(note_count, 1)
        if margin < AMBIGUITY_MARGIN_PER_NOTE:
            reasons.append("quantization_ambiguous")
    if alignment_uncertain:
        reasons.append("beat_alignment_uncertain")
    return tuple(reasons)


def _quantize(
    notes: tuple[NormalizedNote, ...],
    meter_map: MeterMap,
    profile: QuantizationProfile,
    *,
    alignment_shift_sec: float,
    alignment_uncertain: bool,
) -> tuple[QuantizationAlternative, ...]:
    """Core onset quantization over already-normalized notes."""
    if not notes:
        return ()
    ordered = onset_sorted(notes)
    candidates = tuple(
        generate_onset_candidates(note, profile) for note in ordered
    )
    paths = kbest_onset_paths(ordered, candidates, profile)

    reasons_extra: tuple[str, ...] = ()
    if not paths:
        # No strictly increasing candidate chain exists (pathological input
        # such as several notes whose only candidate is position 0). Fall
        # back to the repaired nearest-grid snap so output stays monotonic
        # and flag it for review (design 27 vocabulary).
        snapped = tuple(
            snap_to_grid_ql(note.onset_ql, profile.min_note_value_ql) for note in ordered
        )
        repaired = monotonic_positions(snapped, profile.min_note_value_ql)
        paths = (
            OnsetPath(
                positions=repaired,
                cost=evaluate_onset_path_cost(repaired, ordered, profile),
            ),
        )
        reasons_extra = ("overlapping_candidates",)

    segment = meter_map.segments[0]
    reasons = (
        _review_reasons(paths, len(ordered), alignment_uncertain) + reasons_extra
    )
    ambiguous = 1 if "quantization_ambiguous" in reasons else 0

    alternatives: list[QuantizationAlternative] = []
    for rank, path in enumerate(paths, start=1):
        next_cost = paths[rank].cost if rank < len(paths) else None
        diagnostics = QuantizationDiagnostics(
            weights_version=profile.weights.weights_version,
            meter=f"{segment.numerator}/{segment.denominator}",
            min_note_value_ql=profile.min_note_value_ql,
            triplet_policy=profile.triplet_policy,
            alignment_shift_sec=alignment_shift_sec,
            path_cost=path.cost,
            alternative_cost=next_cost,
            ambiguous_region_count=ambiguous,
            symbol_count=len(ordered),
            review_reasons=reasons,
        )
        alternatives.append(
            QuantizationAlternative(
                rank=rank,
                total_cost=path.cost,
                notes=assemble_quantized_notes(
                    ordered, path.positions, profile.min_note_value_ql
                ),
                diagnostics=diagnostics,
            )
        )
    return tuple(alternatives)


def quantize_normalized(
    notes: Sequence[NormalizedNote],
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
) -> tuple[QuantizationAlternative, ...]:
    """Quantize already-normalized onsets (design 32, steps 4-5).

    Input is in float musical time (the output of
    :func:`hornscribe.rhythm.normalize_to_score_time`); the global alignment
    shift search is a seconds-domain step and therefore lives in
    :func:`quantize_events` — here ``alignment_shift_sec`` is reported as
    ``0.0``.

    Returns up to ``profile.k_best`` alternatives ordered by the documented
    deterministic tie-break (design 44); every emitted onset sequence is
    strictly increasing. Empty input returns an empty tuple.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    meter_map = meter_map if meter_map is not None else _default_meter_map()
    return _quantize(
        tuple(notes),
        meter_map,
        profile,
        alignment_shift_sec=0.0,
        alignment_uncertain=False,
    )


def quantize_events(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    *,
    search_alignment: bool = True,
) -> tuple[QuantizationAlternative, ...]:
    """Quantize raw events end to end: alignment search -> normalize -> DP.

    When ``search_alignment`` is enabled and
    ``profile.max_alignment_shift_sec > 0`` the global latency shift is
    estimated first (design 6.3) and applied before normalization; the chosen
    shift is reported in ``diagnostics.alignment_shift_sec``. Untrustworthy
    searches surface ``"beat_alignment_uncertain"`` in
    ``diagnostics.review_reasons`` instead of being silently applied.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    meter_map = meter_map if meter_map is not None else _default_meter_map()
    events = tuple(events)
    if not events:
        return ()

    shift = 0.0
    uncertain = False
    if search_alignment and profile.max_alignment_shift_sec > 0:
        estimate = estimate_alignment_shift(events, warp, profile)
        # Design 6.3: an untrustworthy estimate (band edge / competing peaks)
        # is *not* auto-applied — it becomes a review reason instead.
        if not estimate.uncertain:
            shift = estimate.shift_sec
        uncertain = estimate.uncertain

    normalized = normalize_to_score_time(events, warp, alignment_shift_sec=shift)
    return _quantize(
        normalized,
        meter_map,
        profile,
        alignment_shift_sec=shift,
        alignment_uncertain=uncertain,
    )
