"""HSQ-v1 quantizer (QNT-002..005; design 7-20, 32-33).

Pipeline implemented here (design 32):

1. ``normalize`` — raw events pass through the :class:`TimeWarp` into float
   quarterLength (:func:`hornscribe.rhythm.normalize_to_score_time`);
   a global alignment shift ``delta_sec`` compensating AMT/beat latency is
   searched *before* this step (design 6.3);
2. ``triplet gate`` — simple-meter beats are evaluated for triplet evidence
   (design 17.2, :mod:`hornscribe.rhythm.triplet`); enabled regions feed
   both the lattice and the realizer so the grid mode is applied uniformly;
3. ``candidates`` — per-note binary lattice plus triplet points inside
   enabled regions (design 8, :mod:`hornscribe.rhythm.lattice`);
4. ``DP`` — deterministic top-K monotonic onset search over Huber onset
   cost + IOI cost + grid-mode-switch cost (design 9-11, 18,
   :mod:`hornscribe.rhythm.dp`), where every transition also evaluates the
   joint note-duration/rest realization of the interval it closes —
   including tuplet group/atom notation cost (design 7.3, 12/33,
   :mod:`hornscribe.rhythm.realize`);
5. alternatives — up to ``k_best`` ranked :class:`QuantizationAlternative`
   objects (design 19) carrying realized notes, rests, tuplet counts and
   ambiguity diagnostics (design 20, 36.2, 40-41).

Passing ``realize_durations=False`` restores the QNT-002 onset-only behavior
(provisional span-to-next-onset durations, ``notation=None``, no rests) —
kept as the timing-only ablation switch for benchmarks and tests.

Still absent at this phase (later milestones): 16th-note tuplets, compound
tuplets, swing, grace notes. Raw event durations are never mutated.
"""

from __future__ import annotations

import bisect
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.rhythm._output import (
    assemble_path_rests,
    assemble_quantized_notes,
    assemble_realized_notes,
    monotonic_positions,
    onset_sorted,
)
from hornscribe.rhythm.contracts import (
    NormalizedNote,
    QuantizationAlternative,
    QuantizationDiagnostics,
    RhythmAtom,
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
from hornscribe.rhythm.realize import TINY_REST_MAX_QL, SpanRealizer
from hornscribe.rhythm.swing import (
    SWING_SNAP_PHASE_HI,
    SWING_SNAP_PHASE_LO,
    detect_swing,
)
from hornscribe.rhythm.timewarp import TimeWarp, normalize_to_score_time
from hornscribe.rhythm.triplet import (
    TripletRegion,
    TripletRegionEvidence,
    enabled_triplet_regions,
    region_containing,
    region_evidence,
    simple_meter_regions,
    strict_triplet_regions,
)

#: Coarse alignment-shift search step (design 6.3: ±120 ms band).
ALIGNMENT_COARSE_STEP_SEC = 0.005
#: Refinement step around the coarse winner.
ALIGNMENT_FINE_STEP_SEC = 0.001
#: Per-note cost margin below which rank-2 counts as ambiguous (design 20).
AMBIGUITY_MARGIN_PER_NOTE = 0.15
#: Relative tolerance for competing local minima in the shift surface (6.3).
ALIGNMENT_COMPETING_MIN_REL = 0.05
#: "On the strong grid" tolerance for the metrical tie-break (6.3 +
#: #78): an onset counts toward a phase when it sits within this many
#: quarterLengths of a first-subdivision point (triangular kernel —
#: humanized timing keeps partial credit instead of a hard cutoff).
ALIGNMENT_STRONG_EPS_QL = 0.06
#: Decisiveness margins for the tie-break: the leader must beat the
#: runner-up by this fraction of the total confidence weight AND hold
#: at least this fraction of it itself — below either bar the phase
#: order stays genuinely ambiguous (e.g. an eighth-note run shifted by
#: a whole eighth, where every phase looks identical).
ALIGNMENT_STRONG_MARGIN = 0.15
ALIGNMENT_STRONG_EVIDENCE = 0.30
#: Metrical weights for the strong-grid kernel: onsets on a beat
#: carry full credit, subdivision hits carry less - an all-on-beats
#: phase must beat an all-on-triplet-thirds alias (they read
#: identically under a flat union: design 6.3 + #78).
ALIGNMENT_STRONG_WEIGHT_BEAT = 1.0
ALIGNMENT_STRONG_WEIGHT_EIGHTH = 0.65
ALIGNMENT_STRONG_WEIGHT_THIRD = 0.45
ALIGNMENT_STRONG_WEIGHT_COMPOUND_EIGHTH = 0.6
#: Widened eligibility for the tie-break (6.3 + #78): the competing-
#: minima rule only watches minima within the 5% relative tolerance of
#: the winner, but a systematic detection bias can make the offbeat
#: phase fit *slightly tighter* than the true phase — honest
#: candidates then sit a few per-weight units outside the band and
#: never reach the tie-break. Eligible coarse local minima are those
#: within this extra absolute margin (scaled by the total confidence
#: weight); phases that are meaningfully worse still never compete.
ALIGNMENT_TIEBREAK_PER_WEIGHT = 0.02
#: Raw-offset overrun past the next onset (in grid steps) that counts as an
#: "extreme" overlap worth a ``overlapping_candidates`` review reason
#: (design 27); smaller overruns are clipped silently and only counted.
OVERLAP_REVIEW_MIN_STEPS = 1.0
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
    meter_resolved: bool = False
    """The surface had competing minima but the metrical-strength
    tie-break picked a clear winner (#78) — reported so diagnostics can
    tell a resolved ambiguity from a clean single minimum."""

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
    meter_map: MeterMap | None = None,
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

    When ``meter_map`` is given, the residual is measured against the
    *notatable lattice* — the union of the fine grid and the segment's
    ternary beat subdivision — instead of the fine grid alone (#78):
    an onset sitting exactly on a triplet position is correctly placed
    for notation purposes, so it must not carry a residual that a
    global shift can "improve". Without this, swung or triplet-heavy
    material lets a compromise phase win: nudging every onset slightly
    off the true grid trades perfect on-beats for tighter triplet fits
    (the Huber cost rewards spreading the residual). The union lattice
    also resolves the classic eighth-run alias, where a systematic
    detection bias made the *offbeat* sixteenth phase fit the fine
    lattice tighter than the true on-eighth phase.

    When competing minima remain (phases whose union-lattice residuals
    tie within tolerance), a metrical tie-break counts the onsets each
    phase lands on the strong first-subdivision grid and applies the
    leader when the gap is decisive - resolving the index aliases
    where every onset sits exactly one subdivision column off (flagged
    ``meter_resolved`` on the estimate). Otherwise the estimate stays
    ``uncertain`` as before.
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

    # Per-segment lattices (see the docstring). ``third`` = beat/3 is the
    # ternary subdivision unioned into the notatable lattice (a no-op in
    # compound meters, where it IS the eighth grid). ``strong`` = the
    # weighted strong points (beat-local ql offset, weight) the
    # tie-break kernel scores against - beats first, then eighths,
    # then triplet thirds, so a shuffle still counts as on-grid while
    # an all-thirds alias loses to an all-beats phase. Stored as
    # floats: the search is a heuristic score, not a contract boundary.
    seg_lattices: tuple[
        tuple[
            float,
            float,
            float,
            Fraction,
            tuple[tuple[float, float], ...],
        ],
        ...,
    ] = ()
    if meter_map is not None and meter_map.segments:
        seg_lattices = tuple(
            (
                float(seg.start_ql),
                float(seg.measure_length_ql),
                float(seg.measure_phase_ql),
                seg.beat_unit_ql / 3,
                (
                    (
                        (0.0, ALIGNMENT_STRONG_WEIGHT_BEAT),
                        (
                            float(seg.beat_unit_ql / 3),
                            ALIGNMENT_STRONG_WEIGHT_COMPOUND_EIGHTH,
                        ),
                        (
                            float(seg.beat_unit_ql * 2 / 3),
                            ALIGNMENT_STRONG_WEIGHT_COMPOUND_EIGHTH,
                        ),
                    )
                    if seg.is_compound
                    else (
                        (0.0, ALIGNMENT_STRONG_WEIGHT_BEAT),
                        (
                            float(seg.beat_unit_ql / 2),
                            ALIGNMENT_STRONG_WEIGHT_EIGHTH,
                        ),
                        (
                            float(seg.beat_unit_ql / 3),
                            ALIGNMENT_STRONG_WEIGHT_THIRD,
                        ),
                        (
                            float(seg.beat_unit_ql * 2 / 3),
                            ALIGNMENT_STRONG_WEIGHT_THIRD,
                        ),
                    )
                ),
            )
            for seg in meter_map.segments
        )
    seg_starts = tuple(row[0] for row in seg_lattices)

    def _segment(
        x: float,
    ) -> tuple[
        float, float, float, Fraction, tuple[tuple[float, float], ...]
    ]:
        i = bisect.bisect_right(seg_starts, x) - 1
        return seg_lattices[max(0, i)]

    def score(delta_sec: float) -> float:
        total = 0.0
        for t, w in zip(onsets, weights, strict=True):
            x = float(warp.seconds_to_ql(t + delta_sec))
            d = grid_distance_ql(x, step_ql)
            if seg_lattices:
                start, mlen, phase, third, _steps = _segment(x)
                local = (x - start + phase) % mlen
                d = min(d, grid_distance_ql(local, third))
            total += w * huber(d / sigma, k)
        return total

    def strong_hits(delta_sec: float) -> float:
        """Weighted strength of the strong-grid points onsets land on
        - the tie-break metric among near-equal lattice fits: a phase
        putting every onset on odd sixteenths scores ~0, one putting
        them on beats scores highest, and an all-triplet-thirds alias
        sits below a real on-beats reading (#78). A per-onset max over
        the tiered points, not a distance sum, so 'uniformly slightly
        off beats' cannot outscore 'half the onsets exactly on
        beats'."""
        total = 0.0
        for t, w in zip(onsets, weights, strict=True):
            x = float(warp.seconds_to_ql(t + delta_sec))
            start, mlen, phase, third, strong = _segment(x)
            local = (x - start + phase) % mlen
            beat_ql = float(third * 3)
            hit = 0.0
            for offset, level_w in strong:
                d = grid_distance_ql(local - offset, beat_ql)
                hit = max(
                    hit,
                    level_w * max(0.0, 1.0 - d / ALIGNMENT_STRONG_EPS_QL),
                )
            total += w * hit
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
    competing_deltas: list[float] = []
    local_minima: list[tuple[float, float]] = []
    for i in range(1, len(coarse_deltas) - 1):
        s = coarse_scores[i]
        is_local_min = s < coarse_scores[i - 1] and s <= coarse_scores[i + 1]
        if (
            is_local_min
            and abs(coarse_deltas[i] - best) > fine_step_sec
        ):
            local_minima.append((coarse_deltas[i], s))
            if s <= best_score + margin:
                competing_deltas.append(coarse_deltas[i])

    band_edge = abs(abs(best) - band) <= fine_step_sec
    total_weight = sum(weights)

    # #78 metrical tie-break: near-equal lattice fits stay ambiguous to the
    # residual alone (the classic case is a systematic detection bias where
    # the *offbeat* sixteenth phase and the true on-beat phase tie). Among
    # the competing phases, the one landing onsets on stronger boundaries
    # is the musically consistent reading — apply it when the strength gap
    # is decisive. A band-edge winner stays uncertain regardless: the true
    # shift may live outside the search band and no tie-break fixes that.
    # Eligibility is wider than the uncertainty tolerance: a systematic
    # detection bias can make the offbeat phase fit *slightly tighter*
    # than the true phase, so honest candidates sit a few per-weight
    # units outside the relative band and never reach the tie-break
    # (ALIGNMENT_TIEBREAK_PER_WEIGHT).
    meter_resolved = False
    if seg_lattices and not band_edge:
        tiebreak_margin = max(
            margin, ALIGNMENT_TIEBREAK_PER_WEIGHT * total_weight
        )
        eligible = [
            d for d, s in local_minima if s <= best_score + tiebreak_margin
        ]
    else:
        eligible = []
    if eligible:
        candidates = [best, *eligible]
        by_strength = sorted(
            candidates,
            key=lambda d: (-strong_hits(d), abs(d), d),
        )
        lead, second = by_strength[0], by_strength[1]
        if (
            strong_hits(lead) - strong_hits(second)
            >= ALIGNMENT_STRONG_MARGIN * total_weight
            and strong_hits(lead) >= ALIGNMENT_STRONG_EVIDENCE * total_weight
        ):
            if abs(lead - best) > fine_step_sec:
                # The strength-preferred phase is a competing minimum —
                # refine it on the lattice score inside its own basin
                # before applying (it may sit a few ms off its coarse
                # grid point).
                lead, _lead_score = search(
                    max(-band, lead - coarse_step_sec),
                    min(band, lead + coarse_step_sec),
                    fine_step_sec,
                )
            best = lead
            meter_resolved = True
            competing_deltas = []
        else:
            # The widened set could not be separated by metrical
            # strength either — every eligible phase is a live
            # ambiguity, so flag rather than silently apply the winner.
            competing_deltas = eligible

    return AlignmentEstimate(
        shift_sec=best,
        score=score(best) if meter_resolved else best_score,
        band_edge=band_edge,
        competing_minima=0 if meter_resolved else len(competing_deltas),
        meter_resolved=meter_resolved,
    )


_AtomSignature = tuple[Fraction, str, int, str | None, bool, bool]
"""Notation-comparable fingerprint of one atom (design 20 comparisons)."""


def _atoms_signature(atoms: tuple[RhythmAtom, ...]) -> tuple[_AtomSignature, ...]:
    """Notation-comparable fingerprint of one atom sequence."""
    return tuple(
        (a.duration_ql, a.symbol, a.dots, a.tuplet, a.is_rest, a.tie_to_next)
        for a in atoms
    )


def _differing_note_indices(a: OnsetPath, b: OnsetPath) -> tuple[int, ...]:
    """Note indices where two paths produce *different notation* (design 20).

    Onset-only paths compare positions (position == provisional notation);
    realized paths compare onset, written note end and the note/rest atom
    signatures — grid-family bookkeeping alone never counts (a triplet
    candidate and a binary candidate at the same position write the same
    atoms and must not flag ambiguity).
    """
    n = len(a.positions)
    if a.realizations and b.realizations:
        out = []
        for i in range(n):
            ra, rb = a.realizations[i], b.realizations[i]
            if (
                a.positions[i] != b.positions[i]
                or ra.note_end_ql != rb.note_end_ql
                or _atoms_signature(ra.note.atoms) != _atoms_signature(rb.note.atoms)
                or _atoms_signature(ra.rest_atoms) != _atoms_signature(rb.rest_atoms)
            ):
                out.append(i)
        return tuple(out)
    return tuple(i for i in range(n) if a.positions[i] != b.positions[i])


def _count_runs(indices: tuple[int, ...]) -> int:
    """Number of contiguous index runs — the ambiguous-region count."""
    runs = 0
    prev = -2
    for i in indices:
        if i != prev + 1:
            runs += 1
        prev = i
    return runs


def _review_reasons(
    paths: tuple[OnsetPath, ...],
    note_count: int,
    alignment_uncertain: bool,
) -> tuple[tuple[str, ...], int]:
    """Internal review reason strings + ambiguous-region count (design 20/40).

    ``quantization_ambiguous`` fires only when rank-1 and rank-2 are close
    enough *and* their resulting notation differs — equal-cost paths that
    produce the same written score (e.g. binary/triplet grid labels on a
    shared position) are never flagged.
    """
    del note_count  # margin normalizes over affected notes, not the passage
    reasons: list[str] = []
    regions = 0
    if len(paths) >= 2:
        differing = _differing_note_indices(paths[0], paths[1])
        if differing:
            margin = (paths[1].cost - paths[0].cost) / len(differing)
            if margin < AMBIGUITY_MARGIN_PER_NOTE:
                reasons.append("quantization_ambiguous")
                regions = _count_runs(differing)
    if alignment_uncertain:
        reasons.append("beat_alignment_uncertain")
    return tuple(reasons), regions


def _region_has_triplet_atoms(path: OnsetPath, region: TripletRegion) -> bool:
    """Whether the path committed triplet notation inside ``region``.

    Two proofs: any interval atom carrying a tuplet label inside the region,
    or a committed onset position on a region-*interior* third — only
    triplet atoms can begin or end there, so such a position forces triplet
    notation even in onset-only output.
    """
    for pos in path.positions:
        if region.is_interior_point(pos):
            return True
    for rlz in path.realizations:
        pos = rlz.start_ql
        for atom in rlz.note.atoms:
            if atom.tuplet is not None and region.start_ql <= pos < region.end_ql:
                return True
            pos += atom.duration_ql
        if rlz.rest is not None:
            pos = rlz.note_end_ql
            for atom in rlz.rest.atoms:
                if atom.tuplet is not None and region.start_ql <= pos < region.end_ql:
                    return True
                pos += atom.duration_ql
    return False


def _triplet_review_reasons(
    paths: tuple[OnsetPath, ...],
    evidence: tuple[TripletRegionEvidence, ...],
) -> tuple[str, ...]:
    """``possible_triplet`` when triplet evidence lost to binary (design 40).

    A region with at least one triplet-relevant onset whose rank-1 path
    committed no triplet notation is flagged — the evidence existed but the
    gate or the cost model kept binary notation, so a reviewer should look.
    Onset-only output has no atoms at all, so only the position check can
    clear an evidenced region.
    """
    if not paths:
        return ()
    best = paths[0]
    for ev in evidence:
        if ev.relevant_onsets >= 1 and not _region_has_triplet_atoms(best, ev.region):
            return ("possible_triplet",)
    return ()


def _phase_review_reasons(
    meter_map: MeterMap, ordered: tuple[NormalizedNote, ...]
) -> tuple[str, ...]:
    """Internal review reasons for ambiguous upstream-supplied phase.

    ``measure_phase_ql`` is strictly manual input per design section 22
    (automatic pickup inference is a non-goal), so a phase supplied by an
    upstream caller is *declared* structure. Two deterministic signals flag
    it for review instead of silently engraving it:

    * a nonzero phase on a non-initial segment declares a partial measure
      at a mid-piece meter change — legal, but semantically ambiguous (did
      the previous measure run short, or does a new anacrusis begin?);
    * a declared pickup measure (first segment, phase > 0) that contains
      no onset is unverifiable from the content — the phase may be an
      upstream mis-estimate rather than a real anacrusis.

    Both surface ``"pickup_ambiguous"`` (design section 40 vocabulary; the
    ReviewIssue mapper consumes these strings).
    """
    segments = meter_map.segments
    reasons: list[str] = []
    if any(seg.measure_phase_ql > 0 for seg in segments[1:]):
        reasons.append("pickup_ambiguous")
    first = segments[0]
    if first.measure_phase_ql > 0:
        lo = float(first.start_ql)
        hi = float(first.first_downbeat_ql)
        if not any(lo <= n.onset_ql < hi for n in ordered):
            reasons.append("pickup_ambiguous")
    return tuple(reasons)


@dataclass(frozen=True)
class _RealizationCounts:
    """Notation-complexity counters for one realized path (design 36.2/41)."""

    tie_count: int
    tiny_rest_count: int
    second_dot_count: int
    strong_boundary_obscured_count: int
    overlap_clipped_count: int
    max_overlap_ql: float


def _realization_diagnostics(
    ordered: tuple[NormalizedNote, ...],
    path: OnsetPath,
    extra_strong: int,
    profile: QuantizationProfile,
) -> tuple[_RealizationCounts, tuple[str, ...]]:
    """Aggregate notation-complexity counters + review reasons for a path.

    Returns the diagnostics field values and the realization-specific review
    reasons: ``overlapping_candidates`` when a raw offset overran the next
    onset by at least a grid step (design 27), ``offset_ambiguous`` when a
    raw offset reversed/collapsed onto its onset (design 40).
    """
    step = float(profile.min_note_value_ql)
    note_atoms = [a for rlz in path.realizations for a in rlz.note.atoms]
    rest_atoms = [
        a
        for rlz in path.realizations
        if rlz.rest is not None
        for a in rlz.rest.atoms
    ]
    overlaps = [r.raw_overlap_ql for r in path.realizations if r.raw_overlap_ql > 0]
    counts = _RealizationCounts(
        tie_count=sum(r.tie_count for r in path.realizations),
        tiny_rest_count=sum(
            1 for a in rest_atoms if a.duration_ql < TINY_REST_MAX_QL
        ),
        second_dot_count=sum(1 for a in note_atoms + rest_atoms if a.dots == 2),
        strong_boundary_obscured_count=sum(
            r.strong_boundary_obscured for r in path.realizations
        )
        + extra_strong,
        overlap_clipped_count=len(overlaps),
        max_overlap_ql=max(overlaps, default=0.0),
    )
    reasons: list[str] = []
    if any(o >= step * OVERLAP_REVIEW_MIN_STEPS for o in overlaps):
        reasons.append("overlapping_candidates")
    if any(n.offset_ql <= n.onset_ql for n in ordered):
        reasons.append("offset_ambiguous")
    return counts, tuple(reasons)


def _swing_snap_beats(
    ordered: tuple[NormalizedNote, ...],
    meter_map: MeterMap,
    strict_regions: tuple[TripletRegion, ...],
) -> tuple[tuple[TripletRegion | None, ...], bool]:
    """Per-note containing beat when its onset is a swung offbeat (#88).

    A detected shuffle writes swung offbeats as *straight* eighths:
    notation keeps equal halves and the payload's ``swingFeel`` carries
    the feel — dotted-16th pairs plus a swing mark would double-apply
    it. Notes inside a strict triplet region keep their triplet
    lattice, and onsets outside the snap band keep normal candidates,
    so genuine triplets and dotted pickups survive a swung context.
    The flag doubles as the 'the off-grid evidence is swing' signal
    that suppresses the ``possible_triplet`` review reason.
    """
    none = tuple(None for _ in ordered)
    if not ordered:
        return none, False
    beat_ql = Fraction(4, meter_map.segments[0].denominator)
    if not detect_swing((n.onset_ql for n in ordered), beat_ql).detected:
        return none, False
    beats = simple_meter_regions(
        meter_map,
        Fraction(ordered[0].onset_ql),
        Fraction(ordered[-1].onset_ql) + Fraction(1),
    )
    strict_starts = [r.start_ql for r in strict_regions]
    out: list[TripletRegion | None] = []
    for note in ordered:
        beat = region_containing(beats, note.onset_ql)
        if beat is None:
            out.append(None)
            continue
        rel = note.onset_ql - float(beat.start_ql)
        unit = float(beat.beat_unit_ql)
        if not (SWING_SNAP_PHASE_LO * unit <= rel <= SWING_SNAP_PHASE_HI * unit):
            out.append(None)
            continue
        i = bisect.bisect_right(strict_starts, note.onset_ql) - 1
        if i >= 0 and note.onset_ql < float(strict_regions[i].end_ql):
            out.append(None)
            continue
        out.append(beat)
    return tuple(out), True


def _quantize(
    notes: tuple[NormalizedNote, ...],
    meter_map: MeterMap,
    profile: QuantizationProfile,
    *,
    alignment_shift_sec: float,
    alignment_uncertain: bool,
    alignment_meter_resolved: bool = False,
    realize_durations: bool = True,
) -> tuple[QuantizationAlternative, ...]:
    """Core quantization over already-normalized notes.

    With ``realize_durations`` (default) each DP transition jointly evaluates
    the note+rest decomposition of the interval it closes (design 12/33) and
    alternatives carry real notation atoms + rests. Disabled, it falls back
    to provisional onset-only output — the timing-only ablation switch.
    """
    if not notes:
        return ()
    ordered = onset_sorted(notes)
    score_start = meter_map.segments[0].start_ql

    # Triplet region gate (design 17.2): the *same* enabled region set feeds
    # the candidate lattice and the realizer — the grid mode is applied
    # uniformly, so a committed triplet-mode onset can always be written
    # with triplet atoms and a binary-mode onset is never secretly tuplet.
    evidence = region_evidence(ordered, meter_map, profile)
    triplet_regions = enabled_triplet_regions(evidence, profile)
    strict_regions = strict_triplet_regions(evidence, profile)
    snap_beats, swing_detected = _swing_snap_beats(ordered, meter_map, strict_regions)
    candidates = tuple(
        generate_onset_candidates(
            note,
            profile,
            min_position_ql=score_start,
            triplet_regions=triplet_regions,
            strict_triplet_regions=strict_regions,
            snap_mid_beat=snap_beats[i],
        )
        for i, note in enumerate(ordered)
    )
    realizer = (
        SpanRealizer(meter_map, profile, triplet_regions=triplet_regions)
        if realize_durations
        else None
    )
    paths = kbest_onset_paths(ordered, candidates, profile, realizer)

    reasons_extra: tuple[str, ...] = ()
    if not paths:
        # No strictly increasing candidate chain exists (pathological input
        # such as several notes whose only candidate is position 0). Fall
        # back to the repaired nearest-grid snap so output stays monotonic
        # and flag it for review (design 27 vocabulary).
        snapped = tuple(
            snap_to_grid_ql(
                note.onset_ql, profile.min_note_value_ql, minimum=score_start
            )
            for note in ordered
        )
        repaired = monotonic_positions(snapped, profile.min_note_value_ql)
        realizations = (
            realizer.realize_path(repaired, ordered) if realizer is not None else ()
        )
        paths = (
            OnsetPath(
                positions=repaired,
                cost=evaluate_onset_path_cost(repaired, ordered, profile)
                + sum(r.cost for r in realizations),
                realizations=realizations,
            ),
        )
        reasons_extra = ("overlapping_candidates",)

    segment = meter_map.segments[0]
    base_reasons, ambiguous = _review_reasons(paths, len(ordered), alignment_uncertain)
    reasons = (
        base_reasons
        + _phase_review_reasons(meter_map, ordered)
        # A detected shuffle explains the off-grid evidence better than
        # 'maybe triplets' (#88) — the pipeline's swing_feel issue
        # carries the real reading.
        + (() if swing_detected else _triplet_review_reasons(paths, evidence))
        + reasons_extra
    )

    alternatives: list[QuantizationAlternative] = []
    for rank, path in enumerate(paths, start=1):
        next_cost = paths[rank].cost if rank < len(paths) else None
        if realizer is not None:
            qnotes = assemble_realized_notes(
                ordered, path.positions, path.realizations
            )
            rests, extra_strong = assemble_path_rests(
                path.positions, path.realizations, realizer
            )
            counts, extra_reasons = _realization_diagnostics(
                ordered, path, extra_strong, profile
            )
            diagnostics = QuantizationDiagnostics(
                weights_version=profile.weights.weights_version,
                meter=f"{segment.numerator}/{segment.denominator}",
                min_note_value_ql=profile.min_note_value_ql,
                triplet_policy=profile.triplet_policy,
                alignment_shift_sec=alignment_shift_sec,
                alignment_meter_resolved=alignment_meter_resolved,
                path_cost=path.cost,
                alternative_cost=next_cost,
                ambiguous_region_count=ambiguous,
                symbol_count=sum(len(rlz.note.atoms) for rlz in path.realizations)
                + sum(len(r.notation.atoms) for r in rests),
                rest_count=sum(len(r.notation.atoms) for r in rests),
                tuplet_group_count=path.tuplet_group_count,
                span_realization_calls=realizer.piece_calls,
                span_realization_cache_hits=realizer.piece_cache_hits,
                review_reasons=reasons
                + tuple(r for r in extra_reasons if r not in reasons),
                tie_count=counts.tie_count,
                tiny_rest_count=counts.tiny_rest_count,
                second_dot_count=counts.second_dot_count,
                strong_boundary_obscured_count=counts.strong_boundary_obscured_count,
                overlap_clipped_count=counts.overlap_clipped_count,
                max_overlap_ql=counts.max_overlap_ql,
            )
        else:
            qnotes = assemble_quantized_notes(
                ordered, path.positions, profile.min_note_value_ql
            )
            rests = ()
            diagnostics = QuantizationDiagnostics(
                weights_version=profile.weights.weights_version,
                meter=f"{segment.numerator}/{segment.denominator}",
                min_note_value_ql=profile.min_note_value_ql,
                triplet_policy=profile.triplet_policy,
                alignment_shift_sec=alignment_shift_sec,
                alignment_meter_resolved=alignment_meter_resolved,
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
                notes=qnotes,
                diagnostics=diagnostics,
                rests=rests,
            )
        )
    return tuple(alternatives)


def quantize_normalized(
    notes: Sequence[NormalizedNote],
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    *,
    realize_durations: bool = True,
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

    ``realize_durations=False`` produces the QNT-002 onset-only output
    (provisional durations, ``notation=None``, no rests) — the timing-only
    ablation switch.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    meter_map = meter_map if meter_map is not None else _default_meter_map()
    return _quantize(
        tuple(notes),
        meter_map,
        profile,
        alignment_shift_sec=0.0,
        alignment_uncertain=False,
        alignment_meter_resolved=False,
        realize_durations=realize_durations,
    )


def quantize_events(
    events: Sequence[RawNoteEvent],
    warp: TimeWarp,
    meter_map: MeterMap | None = None,
    profile: QuantizationProfile | None = None,
    *,
    search_alignment: bool = True,
    alignment_shift_sec: float | None = None,
    realize_durations: bool = True,
) -> tuple[QuantizationAlternative, ...]:
    """Quantize raw events end to end: alignment search -> normalize -> DP.

    When ``search_alignment`` is enabled and
    ``profile.max_alignment_shift_sec > 0`` the global latency shift is
    estimated first (design 6.3) and applied before normalization; the chosen
    shift is reported in ``diagnostics.alignment_shift_sec``. Untrustworthy
    searches surface ``"beat_alignment_uncertain"`` in
    ``diagnostics.review_reasons`` instead of being silently applied.

    With ``realize_durations`` (default) alternatives carry the joint
    note/rest realization (design 12): notated durations, rest spans, ties
    and notation-complexity diagnostics. ``False`` restores the onset-only
    timing ablation output (design 37, B3-style).
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    meter_map = meter_map if meter_map is not None else _default_meter_map()
    events = tuple(events)
    if not events:
        return ()

    shift = 0.0
    uncertain = False
    resolved = False
    if alignment_shift_sec is not None:
        # #85: caller already estimated the global shift (voice 1 of a
        # multi-voice job) — additional voices must share that grid, not
        # search their own, or the parts would drift against each other.
        shift = alignment_shift_sec
    elif search_alignment and profile.max_alignment_shift_sec > 0:
        estimate = estimate_alignment_shift(
            events, warp, profile, meter_map=meter_map
        )
        # Design 6.3: an untrustworthy estimate (band edge / competing peaks)
        # is *not* auto-applied — it becomes a review reason instead.
        if not estimate.uncertain:
            shift = estimate.shift_sec
        uncertain = estimate.uncertain
        resolved = estimate.meter_resolved

    normalized = normalize_to_score_time(events, warp, alignment_shift_sec=shift)
    return _quantize(
        normalized,
        meter_map,
        profile,
        alignment_shift_sec=shift,
        alignment_uncertain=uncertain,
        alignment_meter_resolved=resolved,
        realize_durations=realize_durations,
    )
