"""8th-note triplet model: regions, evidence gate, triplet positions (QNT-005).

Design references: QUANTIZER_DESIGN.md sections 7.3 (tuplet model), 8.2
(triplet candidate grid), 17.2 (triplet policy + region evidence gate),
18 (grid mode), 36.1 (triplet classification metric).

Scope (issue #19): *8th-note* triplets only — one beat of a simple meter
subdivided into three equal atoms. 16th-note triplets, quintuplets,
septuplets, nested tuplets and swing notation are explicit non-goals.

A :class:`TripletRegion` is one primary beat of a *simple* meter where
triplet candidates/atoms are allowed. Compound meters (6/8) never produce
regions: their native ternary eighth subdivision is meter structure, not a
tuplet — the distinction design section 7.3 requires.

The evidence gate (``TripletPolicy.AUTO``) keeps one isolated off-grid note
from flipping a whole region to triplet: a region becomes triplet-enabled
only when ``>= triplet_gate_min_relevant_onsets`` of its onsets are
*relevant* — the triplet grid fits them strictly better than the binary
grid by ``triplet_relevance_margin_ql``. ``NEVER`` enables nothing,
``ALWAYS`` enables every simple-meter beat.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from fractions import Fraction

from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import NormalizedNote
from hornscribe.rhythm.lattice import grid_distance_ql
from hornscribe.rhythm.meter import MeterMap
from hornscribe.rhythm.profile import QuantizationProfile, TripletPolicy

#: Tuplet label stored on :class:`~hornscribe.rhythm.contracts.RhythmAtom`.
TRIPLET_TUPLET_LABEL = "triplet"

#: Atom durations inside a triplet region, as fractions of the beat unit.
#: ``(1/3, "eighth")`` is the eighth-note triplet; ``(2/3, "quarter")`` is
#: the quarter-note triplet (design 7.3). A full-beat span is *not* a
#: triplet atom — it is an ordinary quarter note.
TRIPLET_ATOM_FRACTIONS: tuple[tuple[Fraction, str], ...] = (
    (Fraction(1, 3), "eighth"),
    (Fraction(2, 3), "quarter"),
)

#: Beat-local window (fraction of the beat unit) around the *first*
#: triplet third that marks an onset as first-third evidence (#88). The
#: same 0.12 window the swing census uses to keep the 1/3, 1/2 and 2/3
#: clusters apart — a run of 2/3-only hits is a shuffle, not triplets.
FIRST_THIRD_ZONE_BEAT = 0.12


@dataclass(frozen=True)
class TripletRegion:
    """One simple-meter beat where 8th-triplet subdivision is enabled.

    ``start_ql``/``end_ql`` are absolute score positions. ``beat_unit_ql``
    is the length of the containing primary beat — ``1 ql`` for all
    supported simple meters (4/4, 3/4, 2/4); it is carried explicitly so
    the tuplet semantics survive future meters instead of being silently
    hard-coded.
    """

    start_ql: Fraction
    beat_unit_ql: Fraction = Fraction(1)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "start_ql", as_exact_fraction(self.start_ql, name="start_ql")
        )
        object.__setattr__(
            self,
            "beat_unit_ql",
            as_exact_fraction(self.beat_unit_ql, name="beat_unit_ql"),
        )
        if self.beat_unit_ql <= 0:
            raise ValueError(f"beat_unit_ql must be > 0, got {self.beat_unit_ql}")

    @property
    def end_ql(self) -> Fraction:
        """End of the region (the next beat start)."""
        return self.start_ql + self.beat_unit_ql

    @property
    def third_positions_ql(self) -> tuple[Fraction, ...]:
        """All four triplet grid points of the region, boundaries included.

        ``(b, b + u/3, b + 2u/3, b + u)`` — the region end doubles as the
        next beat start and closes the last triplet atom.
        """
        unit = self.beat_unit_ql
        return tuple(self.start_ql + unit * k / 3 for k in range(4))

    def contains(self, pos_ql: Fraction | float) -> bool:
        """``True`` when ``pos_ql`` lies in ``[start_ql, end_ql)``."""
        pos = float(pos_ql)
        return float(self.start_ql) <= pos < float(self.end_ql)

    def is_interior_point(self, pos_ql: Fraction) -> bool:
        """``True`` when ``pos_ql`` is a triplet point strictly inside the region."""
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        return pos in self.third_positions_ql[1:-1]


@dataclass(frozen=True)
class TripletRegionEvidence:
    """Binary-vs-triplet local model comparison for one region (17.2).

    ``binary_cost``/``triplet_cost`` sum the per-onset nearest-grid
    distances; ``relevant_onsets`` counts onsets where the triplet grid
    wins by at least the profile's relevance margin.
    """

    region: TripletRegion
    onset_count: int
    relevant_onsets: int
    binary_cost: float
    triplet_cost: float
    #: Relevant onsets sitting near the beat's *first* third (#88). A
    #: run of relevant 2/3 hits without any first-third onset is a
    #: shuffle — the swing census owns it, so it must not extend the
    #: triplet gate.
    first_third_relevant: int = 0

    def gate_open(self, profile: QuantizationProfile) -> bool:
        """Whether AUTO candidacy is justified for this region."""
        return (
            self.relevant_onsets >= profile.triplet_gate_min_relevant_onsets
            and self.triplet_cost < self.binary_cost
        )


def simple_meter_regions(
    meter_map: MeterMap, lo_ql: Fraction, hi_ql: Fraction
) -> tuple[TripletRegion, ...]:
    """All primary beats of non-compound segments covering ``[lo, hi)``.

    Beats straddling a segment boundary are excluded — a meter change can
    cut a beat in half and a triplet bracket cannot span it. Compound
    segments (6/8) contribute nothing: their three-way subdivision is
    native meter structure, not a tuplet (design 7.3).
    """
    lo = as_exact_fraction(lo_ql, name="lo_ql")
    hi = as_exact_fraction(hi_ql, name="hi_ql")
    if hi <= lo:
        return ()
    out: list[TripletRegion] = []
    for i, seg in enumerate(meter_map.segments):
        if seg.is_compound:
            continue
        seg_end = (
            meter_map.segments[i + 1].start_ql if i + 1 < len(meter_map.segments) else None
        )
        unit = seg.beat_unit_ql
        # Beat starts satisfy (pos - start + phase) == 0 (mod unit).
        base = seg.start_ql - seg.measure_phase_ql
        seg_lo = max(lo, seg.start_ql)
        # The beat *containing* seg_lo — #88: onsets just inside the
        # range still live inside this beat; requiring the beat to
        # start >= seg_lo left the first covered beat unable to gate
        # (detection jitter puts the first onset a few ms into it).
        k = (seg_lo - base) // unit
        pos = base + k * unit
        while pos < hi:
            if pos >= seg.start_ql and (seg_end is None or pos + unit <= seg_end):
                out.append(TripletRegion(start_ql=pos, beat_unit_ql=unit))
            pos += unit
    return tuple(out)


def region_containing(
    regions: tuple[TripletRegion, ...], pos_ql: Fraction | float
) -> TripletRegion | None:
    """The region containing ``pos_ql``, or ``None`` (binary-search helper)."""
    starts = [r.start_ql for r in regions]
    i = bisect_right(starts, pos_ql) - 1
    if i < 0:
        return None
    region = regions[i]
    return region if float(pos_ql) < float(region.end_ql) else None


def evaluate_region_evidence(
    notes: tuple[NormalizedNote, ...] | list[NormalizedNote],
    region: TripletRegion,
    profile: QuantizationProfile,
) -> TripletRegionEvidence:
    """Compare the binary and triplet local models on one region's onsets.

    An onset is *triplet-relevant* when the nearest triplet grid point fits
    it strictly better than the nearest binary point by at least
    ``profile.triplet_relevance_margin_ql`` (design 17.2). Beat-start
    onsets can never be relevant — both grids hit them exactly — so they
    neither open the gate nor count against it.
    """
    step = profile.min_note_value_ql
    margin = profile.triplet_relevance_margin_ql
    third = float(region.beat_unit_ql) / 3.0
    onset_count = 0
    relevant = 0
    first_third = 0
    binary_cost = 0.0
    triplet_cost = 0.0
    for note in notes:
        x = note.onset_ql
        if not region.contains(x):
            continue
        onset_count += 1
        # Triplet grid within the region: b + k/3 (k = 0..3), equivalent to
        # snapping the region-relative offset to thirds.
        rel = x - float(region.start_ql)
        triplet_dist = abs(rel - round(rel / third) * third)
        binary_dist = grid_distance_ql(x, step)
        binary_cost += binary_dist
        triplet_cost += triplet_dist
        if triplet_dist + margin < binary_dist:
            relevant += 1
            if abs(rel - third) <= float(region.beat_unit_ql) * FIRST_THIRD_ZONE_BEAT:
                first_third += 1
    return TripletRegionEvidence(
        region=region,
        onset_count=onset_count,
        relevant_onsets=relevant,
        binary_cost=binary_cost,
        triplet_cost=triplet_cost,
        first_third_relevant=first_third,
    )


def region_evidence(
    notes: tuple[NormalizedNote, ...] | list[NormalizedNote],
    meter_map: MeterMap,
    profile: QuantizationProfile,
) -> tuple[TripletRegionEvidence, ...]:
    """Evaluate every simple-meter region covering the note range."""
    if not notes:
        return ()
    lo = min(n.onset_ql for n in notes)
    hi = max(n.onset_ql for n in notes)
    regions = simple_meter_regions(meter_map, Fraction(lo), Fraction(hi) + Fraction(1))
    return tuple(evaluate_region_evidence(notes, r, profile) for r in regions)


def enabled_triplet_regions(
    evidence: tuple[TripletRegionEvidence, ...],
    profile: QuantizationProfile,
) -> tuple[TripletRegion, ...]:
    """Regions where triplet candidates/atoms may appear, per policy (17.2).

    * ``NEVER`` — no regions (tuplets disabled).
    * ``ALWAYS`` — every evaluated region (explicit opt-in).
    * ``AUTO`` — only regions whose evidence gate is open.
    """
    if profile.triplet_policy is TripletPolicy.NEVER:
        return ()
    if profile.triplet_policy is TripletPolicy.ALWAYS:
        return tuple(ev.region for ev in evidence)
    runs = _auto_run_members(evidence)
    return tuple(
        ev.region
        for i, ev in enumerate(evidence)
        if i in runs or ev.gate_open(profile)
    )


def _auto_run_members(
    evidence: tuple[TripletRegionEvidence, ...],
) -> frozenset[int]:
    """Evidence indices that belong to a qualifying triplet run (#88).

    A run is a maximal contiguous chain of regions each showing at
    least one triplet-relevant onset; it qualifies only when some member
    carries *first-third* evidence. Detection jitter splits a coherent
    triplet passage into beats that individually miss the two-relevant
    gate — the run restores them so the passage cannot come out as a
    beat-by-beat mix of triplets and sixteenths. A 2/3-only chain is a
    shuffle instead: no first-third onset means the swing census owns
    the passage and the straight notation must survive for it.
    """
    members: set[int] = set()
    i = 0
    n = len(evidence)
    while i < n:
        if evidence[i].relevant_onsets < 1:
            i += 1
            continue
        j = i
        has_first = False
        while j < n and evidence[j].relevant_onsets >= 1:
            has_first = has_first or evidence[j].first_third_relevant >= 1
            j += 1
        if has_first:
            members.update(range(i, j))
        i = j
    return frozenset(members)


def strict_triplet_regions(
    evidence: tuple[TripletRegionEvidence, ...],
    profile: QuantizationProfile,
) -> tuple[TripletRegion, ...]:
    """Run-qualified regions whose interior is triplet-only (#88).

    Inside a strict region, binary candidates at non-third positions
    are suppressed — the evidence says the whole passage is in triplet
    time, so an interior onset may not snap onto the sixteenth grid and
    break the run's notation. Regions opened by their own per-beat gate
    stay *additive* (mixed triplet/binary figures inside one beat are
    real notation); only the coherent run commits fully.
    """
    if profile.triplet_policy is not TripletPolicy.AUTO:
        return ()
    runs = _auto_run_members(evidence)
    return tuple(ev.region for i, ev in enumerate(evidence) if i in runs)
