"""Joint note-duration/rest realization and notation complexity cost (QNT-003).

Implements QUANTIZER_DESIGN.md sections 12-16, 27 and 33: for each transition
interval ``[p, q)`` between a quantized onset ``p`` and the next onset ``q``
the quantizer chooses the note end ``e`` so the written note span ``[p, e)``
plus the optional rest span ``[e, q)`` jointly minimize

* offset evidence — ``weights.offset * Huber((e - z) / sigma_offset)`` where
  ``z`` is the raw offset (soft evidence only, design 13);
* note-span notation complexity (design 14-15);
* rest-span notation complexity, including the tiny-rest penalty that stops
  small tonguing/staccato/breath gaps from becoming sixteenth rests
  (design 13, 14.2).

Span decomposition (design 16): every span is first split at barlines and
meter-segment starts, then each measure piece is solved by a shortest-path
DP over metrical boundary positions whose edges are single writable symbols
— base, first-dot and second-dot values (triple dots are excluded in HSQ-v1,
design 14.1). Edge cost = ``symbol + tie + dots + obscured-boundary +
tiny-rest`` penalties. A note atom "obscures" an interior boundary strictly
stronger than its own start — a quarter note starting on the "and" of a beat
hides the next beat boundary and pays ``strong_boundary_crossing``; the tied
eighth+eighth decomposition then wins when the cost prefers it (design 15).

Multi-atom note spans tie their atoms (barline/beat splits); rest spans
produce separate rests which never tie (design 16). A complete empty measure
is always a single whole rest, regardless of meter (standard notation rule).

Tuplet model (QNT-005, design 7.3): inside evidence-gated
:class:`~hornscribe.rhythm.triplet.TripletRegion` beats the piece lattice
also contains the region's third positions ``b + k/3`` and may emit
``tuplet="triplet"`` atoms — eighth- and quarter-triplets. Triplet atoms pay
``tuplet_atom`` plus a ``tuplet_group`` charge per *visual* group (a
contiguous run; a new run also starts at every region boundary), and they
never pay binary obscured-boundary penalties — metrical boundaries inside a
tuplet bracket are not "obscured" (design 15). Mixed binary/triplet endpoint
sets are not guaranteed to tile, so span decomposition can fail: the DP
treats an untileable transition as a nonexistent edge.

Monophonic rules (design 13, 26, 27):

* ``e <= q`` always — raw offsets overrunning the next onset are clipped and
  the overrun amount is reported through diagnostics;
* distinct input events are never merged — repeated same-pitch tongued notes
  each keep their own note boundary;
* candidate ends are ``{q}`` (sustain to the next onset) plus the grid points
  neighboring the raw offset (design 12) — and, inside enabled regions, the
  triplet third points (QNT-005).

Piece decompositions are memoized on ``(meter, grid, local start, duration,
is_rest, measure-local triplet regions)`` — identical metrical spans recur
constantly inside a run (design 43); the hit/call counters are surfaced
through :class:`QuantizationDiagnostics`.
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise

from hornscribe.domain.ids import RawNoteEventId
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import (
    NormalizedNote,
    NotationRealization,
    RhythmAtom,
)
from hornscribe.rhythm.costs import confidence_weight, huber
from hornscribe.rhythm.lattice import nearest_grid_index
from hornscribe.rhythm.meter import (
    MeterMap,
    MeterSegment,
    MetricalLevel,
    MetricalTree,
)
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.triplet import (
    TRIPLET_ATOM_FRACTIONS,
    TRIPLET_TUPLET_LABEL,
    TripletRegion,
)

#: Rest atoms shorter than an eighth are "tiny" (design 14.2 tiny-rest penalty).
TINY_REST_MAX_QL = Fraction(1, 2)

#: Grid points examined on each side of the snapped raw offset (design 12:
#: "raw offset前後の隣接grid point").
_INTERIOR_END_NEIGHBORS = 1
#: The phrase-final note has no next-onset bound; allow a slightly wider
#: neighborhood around its raw offset.
_TAIL_END_NEIGHBORS = 2

_BASE_SYMBOLS: tuple[tuple[Fraction, str], ...] = (
    (Fraction(4), "whole"),
    (Fraction(2), "half"),
    (Fraction(1), "quarter"),
    (Fraction(1, 2), "eighth"),
    (Fraction(1, 4), "sixteenth"),
    (Fraction(1, 8), "32nd"),
    (Fraction(1, 16), "64th"),
)

#: Boundary levels whose obscuring costs ``strong_boundary_crossing``;
#: deeper (SUBDIVISION) boundaries cost ``weak_boundary_crossing`` (design 15).
_STRONG_LEVELS = frozenset(
    {MetricalLevel.MEASURE, MetricalLevel.BEAT_GROUP, MetricalLevel.BEAT}
)


@dataclass(frozen=True)
class AtomSpec:
    """One writable single-symbol duration (design 14.1)."""

    duration_ql: Fraction
    symbol: str
    dots: int = 0


def atom_vocabulary(min_note_value_ql: Fraction) -> tuple[AtomSpec, ...]:
    """Single-symbol duration table at the profile's grid resolution.

    Base symbols from ``whole`` down to ``min_note_value_ql``, each with
    first-dot (x3/2) and second-dot (x7/4) variants. Durations that are not a
    multiple of the grid step are dropped — they can never connect two grid
    positions (e.g. a double-dotted sixteenth needs a 32nd grid). Ordered by
    ``(duration, dots)`` for deterministic iteration.
    """
    step = as_exact_fraction(min_note_value_ql, name="min_note_value_ql")
    if step <= 0:
        raise ValueError(f"min_note_value_ql must be > 0, got {step}")
    specs: list[AtomSpec] = []
    for base, name in _BASE_SYMBOLS:
        if base < step:
            continue
        for dots, factor in ((0, Fraction(1)), (1, Fraction(3, 2)), (2, Fraction(7, 4))):
            duration = base * factor
            if duration % step == 0:
                specs.append(AtomSpec(duration, name, dots))
    specs.sort(key=lambda s: (s.duration_ql, s.dots))
    return tuple(specs)


@dataclass(frozen=True)
class SpanDecomposition:
    """Costed atom decomposition of one contiguous span (design 16).

    ``atoms`` are in written order; note spans carry ``tie_to_next`` on every
    atom but the last, rest spans never tie. The counts feed
    :class:`QuantizationDiagnostics`.
    """

    atoms: tuple[RhythmAtom, ...]
    cost: float
    strong_boundary_obscured: int = 0
    weak_boundary_obscured: int = 0
    tiny_rest_count: int = 0
    second_dot_count: int = 0
    tuplet_group_count: int = 0
    """Visual tuplet groups (design 7.3): contiguous triplet-atom runs —
    a new run also starts at every triplet-region boundary."""
    tuplet_atom_count: int = 0

    @property
    def notation(self) -> NotationRealization:
        return NotationRealization(self.atoms)


@dataclass(frozen=True)
class IntervalRealization:
    """The chosen note+rest decomposition of one onset interval (design 12).

    ``note`` tiles ``[start_ql, note_end_ql)`` and ``rest`` — when present —
    tiles ``[note_end_ql, next_onset_ql)``. ``cost`` is the total transition
    cost (offset residual + note-span cost + rest-span cost);
    ``offset_cost`` is only the offset-evidence term. ``raw_overlap_ql``
    records how far the raw offset ran past ``next_onset_ql`` before clipping
    (design 27).
    """

    start_ql: Fraction
    note_end_ql: Fraction
    next_onset_ql: Fraction | None
    note: NotationRealization
    rest: NotationRealization | None
    cost: float
    offset_cost: float
    strong_boundary_obscured: int = 0
    weak_boundary_obscured: int = 0
    raw_overlap_ql: float = 0.0
    tuplet_group_count: int = 0
    """Triplet-atom runs across this interval's note+rest atom stream."""
    tuplet_atom_count: int = 0
    triplet_group_continuation: bool = False
    """The interval's first atom is a triplet atom starting at a
    region-*interior* triplet point — its visual tuplet group necessarily
    began in the previous interval's atoms (only triplet atoms can end on
    an interior triplet point), so the path-level group count must not
    charge that run again (design 7.3/44)."""

    def __post_init__(self) -> None:
        if not self.note_end_ql > self.start_ql:
            raise ValueError(
                f"note end {self.note_end_ql} must be after start {self.start_ql}"
            )
        if self.next_onset_ql is not None:
            if self.next_onset_ql <= self.start_ql:
                raise ValueError(
                    f"next onset {self.next_onset_ql} must be after start {self.start_ql}"
                )
            if self.note_end_ql > self.next_onset_ql:
                raise ValueError(
                    f"note end {self.note_end_ql} overruns next onset "
                    f"{self.next_onset_ql} (monophonic clip violated)"
                )
        if self.note.total_ql != self.note_end_ql - self.start_ql:
            raise ValueError("note atoms must tile the note span exactly")
        if self.rest is not None:
            if self.next_onset_ql is None:
                raise ValueError("a phrase-final interval cannot hold a rest")
            if self.rest.total_ql != self.next_onset_ql - self.note_end_ql:
                raise ValueError("rest atoms must tile the rest span exactly")
        if not math.isfinite(self.cost) or not math.isfinite(self.offset_cost):
            raise ValueError("interval costs must be finite")

    @property
    def symbol_count(self) -> int:
        """All written atoms: note atoms + rest atoms."""
        return len(self.note.atoms) + (len(self.rest.atoms) if self.rest else 0)

    @property
    def tie_count(self) -> int:
        return sum(1 for a in self.note.atoms if a.tie_to_next)

    @property
    def rest_count(self) -> int:
        return len(self.rest.atoms) if self.rest else 0

    @property
    def tiny_rest_count(self) -> int:
        return sum(1 for a in self.rest_atoms if a.duration_ql < TINY_REST_MAX_QL)

    @property
    def second_dot_count(self) -> int:
        return sum(1 for a in self.note.atoms + self.rest_atoms if a.dots == 2)

    @property
    def rest_atoms(self) -> tuple[RhythmAtom, ...]:
        return self.rest.atoms if self.rest else ()


@dataclass(frozen=True)
class _BoundaryInfo:
    """Precomputed boundary positions/depths/levels of one metrical tree."""

    positions: tuple[Fraction, ...]
    depth: dict[Fraction, int]
    level: dict[Fraction, MetricalLevel]
    max_depth: int


@dataclass(frozen=True)
class _PieceResult:
    """Cached measure-local decomposition (design 43 memoization unit)."""

    atoms: tuple[RhythmAtom, ...]
    cost: float
    strong: int
    weak: int
    tiny: int
    dots2: int
    tuplet_groups: int = 0
    tuplet_atoms: int = 0


@dataclass(frozen=True)
class _DPState:
    """Partial decomposition ending at one boundary position."""

    cost: float
    atoms: tuple[RhythmAtom, ...]
    strong: int
    weak: int
    tiny: int
    dots2: int
    tuplet_groups: int = 0
    tuplet_atoms: int = 0
    last_triplet: bool = False
    """Whether the last atom is a triplet atom inside the *same* region —
    a new visual tuplet group starts otherwise (also at region starts)."""

    @property
    def key(self) -> tuple[float, int, int, tuple[Fraction, ...]]:
        """Deterministic decomposition order (design 44): cost, then fewer
        symbols, then fewer tuplets, then lexicographic duration sequence."""
        return (
            self.cost,
            len(self.atoms),
            self.tuplet_groups,
            tuple(a.duration_ql for a in self.atoms),
        )


def _boundary_info(tree: MetricalTree) -> _BoundaryInfo:
    positions = tree.boundary_positions_ql
    depth: dict[Fraction, int] = {}
    level: dict[Fraction, MetricalLevel] = {}
    for pos in positions:
        d = tree.boundary_depth(pos)
        lv = tree.boundary_level(pos)
        depth[pos] = 0 if d is None else d
        level[pos] = MetricalLevel.MEASURE if lv is None else lv
    max_depth = max(n.depth for n in tree.iter_nodes())
    return _BoundaryInfo(positions, depth, level, max_depth)


def _hidden_boundaries(
    info: _BoundaryInfo, start: Fraction, end: Fraction
) -> tuple[int, int]:
    """Count obscured boundaries inside ``(start, end)`` -> (strong, weak).

    A boundary ``b`` is *obscured* when it is strictly inside the atom's span
    and strictly stronger (shallower depth) than the atom's own start — the
    "weak-start span hiding strong beat" case of design 15. Boundaries at or
    below the start's depth are licensed by the start (a whole note from the
    downbeat hides nothing; a half note from the half-bar covers only weaker
    beat boundaries).
    """
    start_depth = info.depth.get(start, info.max_depth + 1)
    strong = weak = 0
    i = bisect_left(info.positions, start) + 1
    while i < len(info.positions) and info.positions[i] < end:
        pos = info.positions[i]
        if info.depth[pos] < start_depth:
            if info.level[pos] in _STRONG_LEVELS:
                strong += 1
            else:
                weak += 1
        i += 1
    return strong, weak


class SpanRealizer:
    """Measure-aware span/interval realization with memoization (design 43).

    One instance per quantization run: it owns the metrical-tree cache, the
    measure-local piece cache (the memoization unit — identical metrical
    spans recur constantly) and the transition-interval cache used by the
    onset DP. ``piece_calls``/``piece_cache_hits`` and
    ``interval_calls``/``interval_cache_hits`` are the profiling counters
    surfaced through diagnostics.

    ``triplet_regions`` are the evidence-gated beats where triplet atoms may
    appear (QNT-005, design 17.2): their third positions join the piece
    lattice and license ``tuplet="triplet"`` atoms. Compound-meter ternary
    subdivisions are native meter structure and never reach this list.
    """

    def __init__(
        self,
        meter_map: MeterMap,
        profile: QuantizationProfile,
        *,
        triplet_regions: tuple[TripletRegion, ...] = (),
    ) -> None:
        # The realizer can only tile measures whose metrical structure sits
        # on the notation grid — reject off-grid starts/phases up front with
        # a MeterMapError instead of failing deep inside the search.
        meter_map.validate_notation_grid(profile.min_note_value_ql)
        self._meter_map = meter_map
        self._profile = profile
        self._weights = profile.weights
        self._step = profile.min_note_value_ql
        self._vocab = atom_vocabulary(self._step)
        self._regions = tuple(sorted(triplet_regions, key=lambda r: r.start_ql))
        self._region_starts = tuple(r.start_ql for r in self._regions)
        self._segment_starts = frozenset(s.start_ql for s in meter_map.segments)
        self._trees: dict[tuple[int, int], MetricalTree] = {}
        self._boundary: dict[tuple[int, int], _BoundaryInfo] = {}
        # Cache key: (meter, local start, local duration, is_rest,
        #             measure-local triplet regions). Untileable spans cache
        # as ``None`` — mixed binary/triplet position sets do not always tile.
        self._piece_cache: dict[
            tuple[
                tuple[int, int],
                Fraction,
                Fraction,
                bool,
                tuple[tuple[Fraction, Fraction], ...],
            ],
            _PieceResult | None,
        ] = {}
        self._interval_cache: dict[
            tuple[Fraction, Fraction | None, float, float | None],
            IntervalRealization | None,
        ] = {}
        self.piece_calls = 0
        self.piece_cache_hits = 0
        self.interval_calls = 0
        self.interval_cache_hits = 0

    @property
    def score_start_ql(self) -> Fraction:
        """Position where the meter map's coverage begins (rest fill origin)."""
        return self._meter_map.segments[0].start_ql

    # --- measure geometry ---------------------------------------------------

    def _tree(self, segment: MeterSegment) -> MetricalTree:
        key = (segment.numerator, segment.denominator)
        tree = self._trees.get(key)
        if tree is None:
            tree = MetricalTree.for_segment(segment, self._step)
            self._trees[key] = tree
        return tree

    def _info(self, segment: MeterSegment) -> _BoundaryInfo:
        key = (segment.numerator, segment.denominator)
        info = self._boundary.get(key)
        if info is None:
            info = _boundary_info(self._tree(segment))
            self._boundary[key] = info
        return info

    def is_measure_boundary(self, pos_ql: Fraction) -> bool:
        """True when ``pos_ql`` is a barline: a downbeat or a meter-change."""
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        if pos in self._segment_starts:
            return True
        return self._meter_map.segment_at(pos).measure_offset_ql(pos) == 0

    def next_measure_boundary(self, pos_ql: Fraction) -> Fraction:
        """First barline strictly after ``pos_ql`` (measure end of its span)."""
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        segment = self._meter_map.segment_at(pos)
        length = segment.measure_length_ql
        bounds = set(self._meter_map.measure_boundaries(pos, pos + 2 * length))
        bounds.update(self._segment_starts)
        after = [b for b in bounds if b > pos]
        # The last meter segment extends indefinitely, so a following
        # downbeat always exists.
        return min(after)

    def _split_points(self, start: Fraction, end: Fraction) -> tuple[Fraction, ...]:
        """Barlines + meter-change boundaries strictly inside ``(start, end)``."""
        cuts = {
            b
            for b in self._meter_map.measure_boundaries(start, end)
            if start < b < end
        }
        cuts.update(s for s in self._segment_starts if start < s < end)
        return tuple(sorted(cuts))

    # --- triplet regions (QNT-005, design 7.3/8.2/17.2) -----------------------

    def _region_at(self, pos_ql: Fraction) -> TripletRegion | None:
        """The enabled triplet region containing ``pos_ql``, or ``None``."""
        if not self._regions:
            return None
        i = bisect_right(self._region_starts, pos_ql) - 1
        if i < 0:
            return None
        region = self._regions[i]
        return region if pos_ql < region.end_ql else None

    def _region_interior(self, pos_ql: Fraction) -> bool:
        """``pos_ql`` strictly inside an enabled region (not at its start)."""
        region = self._region_at(pos_ql)
        return region is not None and region.start_ql < pos_ql

    def _local_regions(
        self, segment: MeterSegment, abs_start: Fraction, abs_end: Fraction
    ) -> tuple[tuple[Fraction, Fraction], ...]:
        """Enabled regions overlapping ``[abs_start, abs_end)``, mapped to
        measure-local coordinates of ``abs_start``'s measure.

        The returned pairs are the regions' *full* local extents — a piece
        sitting inside a region sees the whole beat so triplet positions are
        computed from the region's own thirds, not the intersection.
        """
        if not self._regions:
            return ()
        local_origin = abs_start - segment.measure_offset_ql(abs_start)
        out: list[tuple[Fraction, Fraction]] = []
        for region in self._regions:
            if region.end_ql <= abs_start:
                continue
            if region.start_ql >= abs_end:
                break
            out.append((region.start_ql - local_origin, region.end_ql - local_origin))
        return tuple(out)

    # --- span decomposition (design 16) ---------------------------------------

    def _decompose_piece(
        self,
        segment: MeterSegment,
        local_start: Fraction,
        local_dur: Fraction,
        is_rest: bool,
        local_regions: tuple[tuple[Fraction, Fraction], ...] = (),
    ) -> _PieceResult | None:
        """Memoized measure-local shortest-path decomposition.

        ``local_regions`` are the enabled triplet regions (measure-local
        ``(start, end)`` pairs) overlapping the piece; ``None`` is returned
        when the span cannot be tiled — mixed binary/triplet position sets
        are not guaranteed to tile (e.g. a ``1/12 ql`` gap has no atom).
        """
        key = (
            (segment.numerator, segment.denominator),
            local_start,
            local_dur,
            is_rest,
            local_regions,
        )
        self.piece_calls += 1
        if key in self._piece_cache:
            self.piece_cache_hits += 1
            return self._piece_cache[key]
        result = self._decompose_piece_uncached(
            segment, local_start, local_dur, is_rest, local_regions
        )
        self._piece_cache[key] = result
        return result

    def _decompose_piece_uncached(
        self,
        segment: MeterSegment,
        local_start: Fraction,
        local_dur: Fraction,
        is_rest: bool,
        local_regions: tuple[tuple[Fraction, Fraction], ...],
    ) -> _PieceResult | None:
        tree = self._tree(segment)
        info = self._info(segment)
        weights = self._weights
        local_end = local_start + local_dur

        # A complete empty measure is written as a single whole rest in any
        # meter (standard notation convention, design 16).
        if is_rest and local_start == 0 and local_dur == tree.measure_length_ql:
            atom = RhythmAtom(local_dur, "whole", is_rest=True)
            return _PieceResult((atom,), weights.symbol, 0, 0, 0, 0)

        # Triplet machinery: each region contributes its third positions to
        # the lattice and licenses triplet atoms between them. ``tstart``
        # maps a triplet-atom start point to ``(region_end, beat_unit)`` —
        # atoms may end on any later third of the *same* region but can
        # never cross its boundary (design 7.3).
        tstart: dict[Fraction, tuple[Fraction, Fraction]] = {}
        region_starts: set[Fraction] = set()
        third_points: set[Fraction] = set()
        for rs, re_ in local_regions:
            unit = re_ - rs
            region_starts.add(rs)
            for k in range(3):
                p = rs + unit * k / 3
                if local_start <= p < local_end:
                    tstart[p] = (re_, unit)
            for k in range(4):
                p = rs + unit * k / 3
                if local_start < p < local_end:
                    third_points.add(p)

        positions = sorted(
            {local_start, local_end}
            | {b for b in info.positions if local_start < b < local_end}
            | third_points
        )
        pos_set = frozenset(positions)

        def binary_atom_edges(
            pos: Fraction, state: _DPState
        ) -> list[tuple[Fraction, _DPState]]:
            out = []
            for spec in self._vocab:
                target = pos + spec.duration_ql
                if target > local_end or target not in pos_set:
                    continue
                strong, weak = _hidden_boundaries(info, pos, target)
                tiny = is_rest and spec.duration_ql < TINY_REST_MAX_QL
                # Every atom after the first in a note span joins via a tie
                # (design 14.3 tie cost); rests never tie.
                ties_back = not is_rest and bool(state.atoms)
                cost = (
                    state.cost
                    + weights.symbol
                    + (weights.tie if ties_back else 0.0)
                    + (weights.first_dot if spec.dots >= 1 else 0.0)
                    + (weights.second_dot if spec.dots >= 2 else 0.0)
                    + strong * weights.strong_boundary_crossing
                    + weak * weights.weak_boundary_crossing
                    + (weights.tiny_rest if tiny else 0.0)
                )
                atom = RhythmAtom(
                    spec.duration_ql, spec.symbol, dots=spec.dots, is_rest=is_rest
                )
                out.append(
                    (
                        target,
                        _DPState(
                            cost=cost,
                            atoms=(*state.atoms, atom),
                            strong=state.strong + strong,
                            weak=state.weak + weak,
                            tiny=state.tiny + int(tiny),
                            dots2=state.dots2 + int(spec.dots == 2),
                            tuplet_groups=state.tuplet_groups,
                            tuplet_atoms=state.tuplet_atoms,
                            last_triplet=False,
                        ),
                    )
                )
            return out

        def triplet_atom_edges(
            pos: Fraction, state: _DPState
        ) -> list[tuple[Fraction, _DPState]]:
            entry = tstart.get(pos)
            if entry is None:
                return []
            region_end, unit = entry
            out = []
            for frac, symbol in TRIPLET_ATOM_FRACTIONS:
                duration = frac * unit
                target = pos + duration
                if target > region_end or target > local_end or target not in pos_set:
                    continue
                # Triplet atoms pay the tuplet atom/group cost instead of
                # binary boundary penalties: metrical boundaries inside a
                # tuplet bracket are not "obscured" (design 7.3, 15).
                new_group = not state.last_triplet or pos in region_starts
                tiny = is_rest and duration < TINY_REST_MAX_QL
                ties_back = not is_rest and bool(state.atoms)
                cost = (
                    state.cost
                    + weights.symbol
                    + (weights.tie if ties_back else 0.0)
                    + weights.tuplet_atom
                    + (weights.tuplet_group if new_group else 0.0)
                    + (weights.tiny_rest if tiny else 0.0)
                )
                atom = RhythmAtom(
                    duration,
                    symbol,
                    tuplet=TRIPLET_TUPLET_LABEL,
                    is_rest=is_rest,
                )
                out.append(
                    (
                        target,
                        _DPState(
                            cost=cost,
                            atoms=(*state.atoms, atom),
                            strong=state.strong,
                            weak=state.weak,
                            tiny=state.tiny + int(tiny),
                            dots2=state.dots2,
                            tuplet_groups=state.tuplet_groups + int(new_group),
                            tuplet_atoms=state.tuplet_atoms + 1,
                            last_triplet=True,
                        ),
                    )
                )
            return out

        best: dict[Fraction, _DPState] = {
            local_start: _DPState(0.0, (), 0, 0, 0, 0)
        }
        for pos in positions:
            state = best.get(pos)
            if state is None or pos == local_end:
                continue
            candidates = triplet_atom_edges(pos, state)
            if pos % self._step == 0:
                # A plain binary symbol is not writable from a triplet
                # point — a quarter note cannot begin on "the second third
                # of a beat" — so binary edges only leave binary positions.
                candidates.extend(binary_atom_edges(pos, state))
            for target, cand in candidates:
                current = best.get(target)
                if current is None or cand.key < current.key:
                    best[target] = cand

        final = best.get(local_end)
        if final is None:
            # No tiling exists — e.g. a span mixing triplet and binary
            # endpoints can have a 1/12 ql gap no atom covers.
            return None
        return _PieceResult(
            final.atoms,
            final.cost,
            final.strong,
            final.weak,
            final.tiny,
            final.dots2,
            final.tuplet_groups,
            final.tuplet_atoms,
        )

    def _try_realize_span(
        self, start_ql: Fraction, end_ql: Fraction, *, is_rest: bool
    ) -> SpanDecomposition | None:
        """``realize_span`` returning ``None`` for untileable spans."""
        start = as_exact_fraction(start_ql, name="start_ql")
        end = as_exact_fraction(end_ql, name="end_ql")
        if end <= start:
            raise ValueError(f"empty span: [{start}, {end})")

        cuts = self._split_points(start, end)
        atoms: list[RhythmAtom] = []
        cost = 0.0
        strong = weak = tiny = dots2 = groups = tup_atoms = 0
        for piece_start, piece_end in pairwise((start, *cuts, end)):
            segment = self._meter_map.segment_at(piece_start)
            local_start = segment.measure_offset_ql(piece_start)
            local_regions = self._local_regions(segment, piece_start, piece_end)
            piece = self._decompose_piece(
                segment,
                local_start,
                piece_end - piece_start,
                is_rest,
                local_regions,
            )
            if piece is None:
                return None
            atoms.extend(piece.atoms)
            cost += piece.cost
            strong += piece.strong
            weak += piece.weak
            tiny += piece.tiny
            dots2 += piece.dots2
            groups += piece.tuplet_groups
            tup_atoms += piece.tuplet_atoms
        if not is_rest:
            # Ties at piece junctions (barline/meter-change splits) — each
            # piece charged its internal ties; the junctions between pieces
            # are the remaining ``len(cuts)`` ties (design 15-16).
            cost += self._weights.tie * len(cuts)
        if not is_rest and len(atoms) > 1:
            # Note atoms join with ties across every internal split (design 15).
            tied = [
                RhythmAtom(
                    a.duration_ql,
                    a.symbol,
                    dots=a.dots,
                    tuplet=a.tuplet,
                    tie_to_next=True,
                )
                for a in atoms[:-1]
            ]
            atoms = [*tied, atoms[-1]]
        return SpanDecomposition(
            tuple(atoms),
            cost,
            strong_boundary_obscured=strong,
            weak_boundary_obscured=weak,
            tiny_rest_count=tiny,
            second_dot_count=dots2,
            tuplet_group_count=groups,
            tuplet_atom_count=tup_atoms,
        )

    def realize_span(
        self, start_ql: Fraction, end_ql: Fraction, *, is_rest: bool
    ) -> SpanDecomposition:
        """Decompose ``[start_ql, end_ql)`` into atoms (design 16).

        The span is cut at every interior barline and meter-change boundary;
        each piece is decomposed in its own measure-local metrical tree, so
        atoms never cross a barline. Note spans (``is_rest=False``) join
        their atoms with ties; rest spans never tie.

        Inside enabled triplet regions the piece lattice also contains the
        region's third positions and may emit ``tuplet="triplet"`` atoms —
        eighth- and quarter-triplets (design 7.3); outside them the
        decomposition is exactly the binary vocabulary.

        Raises :class:`ValueError` when the span cannot be tiled — possible
        only at mixed binary/triplet endpoints (e.g. a ``1/12 ql`` gap has
        no writable atom).
        """
        result = self._try_realize_span(start_ql, end_ql, is_rest=is_rest)
        if result is None:
            raise ValueError(
                f"span [{start_ql}, {end_ql}) cannot be written with the "
                "available atom vocabulary"
            )
        return result

    def rest_span(
        self, start_ql: Fraction, end_ql: Fraction
    ) -> NotationRealization | None:
        """Decompose a rest span; ``None`` when the span is empty."""
        start = as_exact_fraction(start_ql, name="start_ql")
        end = as_exact_fraction(end_ql, name="end_ql")
        if end <= start:
            return None
        return self.realize_span(start, end, is_rest=True).notation

    # --- interval realization (design 12) --------------------------------------

    def _candidate_ends(
        self, start: Fraction, next_onset: Fraction | None, offset_ql: float
    ) -> tuple[Fraction, ...]:
        """Candidate note ends for one interval (design 12).

        ``{q}`` (sustain to the next onset) plus the grid points neighboring
        the raw offset ``z``; clipped to ``(start, q]`` so the monophonic
        ``e <= q`` rule holds by construction (design 27). Triplet third
        points inside enabled regions are ends too (QNT-005) — a triplet
        eighth's note span ends on the next third.
        """
        neighbors = _TAIL_END_NEIGHBORS if next_onset is None else _INTERIOR_END_NEIGHBORS
        ends = {next_onset} if next_onset is not None else set()
        k0 = nearest_grid_index(offset_ql, self._step)
        for dk in range(-neighbors, neighbors + 1):
            ends.add(Fraction(k0 + dk) * self._step)
        lo = start + self._step
        # Triplet third points within the interval's enabled regions; for
        # the phrase-final note the binary candidate set bounds the search
        # window the same way it bounds the offset neighborhood. Third ends
        # only need ``e > start`` — a triplet eighth can be shorter than
        # the binary grid step.
        hi = next_onset if next_onset is not None else (max(ends) if ends else None)
        triplet_ends: set[Fraction] = set()
        if self._regions and hi is not None:
            for region in self._regions:
                if region.end_ql <= start:
                    continue
                if region.start_ql >= hi:
                    break  # regions are sorted by start
                for p in region.third_positions_ql:
                    if start < p <= hi:
                        triplet_ends.add(p)
        out = sorted(
            {
                e
                for e in ends
                if e >= lo and (next_onset is None or e <= next_onset)
            }
            | triplet_ends
        )
        if not out:
            # Reversed/degenerate raw offset (design 38): hold to the next
            # onset, or to the smallest writable end for the phrase-final
            # note (the next third point when ``start`` sits on one).
            out = [next_onset] if next_onset is not None else [self._fallback_end(start)]
        return tuple(out)

    def _fallback_end(self, start: Fraction) -> Fraction:
        """Smallest writable end after ``start`` (tail degenerate case)."""
        segment = self._meter_map.segment_at(start)
        if segment.measure_offset_ql(start) % self._step == 0:
            return start + self._step
        region = self._region_at(start)
        if region is not None:
            for p in region.third_positions_ql:
                if p > start:
                    return p
        return start + self._step

    def interval(
        self,
        start_ql: Fraction,
        next_onset_ql: Fraction | None,
        note: NormalizedNote,
    ) -> IntervalRealization | None:
        """Realize one transition interval; memoized per (p, q, z, confidence).

        Returns ``None`` when no candidate note end produces a writable
        span — possible only at mixed binary/triplet endpoints; the DP
        treats such transitions as nonexistent.
        """
        start = as_exact_fraction(start_ql, name="start_ql")
        nxt = (
            None
            if next_onset_ql is None
            else as_exact_fraction(next_onset_ql, name="next_onset_ql")
        )
        key = (start, nxt, note.offset_ql, note.confidence)
        self.interval_calls += 1
        if key in self._interval_cache:
            self.interval_cache_hits += 1
            return self._interval_cache[key]
        result = self._interval_uncached(start, nxt, note.offset_ql, note.confidence)
        self._interval_cache[key] = result
        return result

    def _interval_uncached(
        self,
        start: Fraction,
        next_onset: Fraction | None,
        offset_ql: float,
        confidence: float | None,
    ) -> IntervalRealization | None:
        weights = self._weights
        profile = self._profile
        w = confidence_weight(confidence)
        best: tuple[
            tuple[float, int, int, int, Fraction],
            Fraction,
            float,
            SpanDecomposition,
            SpanDecomposition | None,
        ] | None = None
        for end in self._candidate_ends(start, next_onset, offset_ql):
            note_span = self._try_realize_span(start, end, is_rest=False)
            if note_span is None:
                continue
            rest_span = (
                self._try_realize_span(end, next_onset, is_rest=True)
                if next_onset is not None and end < next_onset
                else None
            )
            if next_onset is not None and end < next_onset and rest_span is None:
                continue
            offset_cost = (
                w
                * weights.offset
                * huber(
                    (float(end) - offset_ql) / profile.sigma_offset_ql, profile.huber_k
                )
            )
            cost = offset_cost + note_span.cost + (rest_span.cost if rest_span else 0.0)
            symbols = len(note_span.atoms) + (
                len(rest_span.atoms) if rest_span else 0
            )
            groups = note_span.tuplet_group_count + (
                rest_span.tuplet_group_count if rest_span else 0
            )
            if (
                rest_span is not None
                and note_span.atoms[-1].tuplet is not None
                and rest_span.atoms[0].tuplet is not None
                and self._region_interior(end)
            ):
                # The note's last triplet atom and the rest's first one share
                # a visual tuplet group — a triplet bracket may hold rests.
                groups -= 1
            # Design 44 order: cost, then fewer symbols, then fewer tuplet
            # groups, then fewer ties, then lexical position (earlier end
            # wins a full tie).
            key = (cost, symbols, groups, len(note_span.atoms) - 1, end)
            if best is None or key < best[0]:
                best = (key, end, offset_cost, note_span, rest_span)
        if best is None:
            return None  # no writable end for this interval
        _, end, offset_cost, note_span, rest_span = best
        overlap = (
            max(0.0, offset_ql - float(next_onset)) if next_onset is not None else 0.0
        )
        groups = note_span.tuplet_group_count + (
            rest_span.tuplet_group_count if rest_span else 0
        )
        if (
            rest_span is not None
            and note_span.atoms[-1].tuplet is not None
            and rest_span.atoms[0].tuplet is not None
            and self._region_interior(end)
        ):
            groups -= 1
        continuation = (
            note_span.atoms[0].tuplet is not None and self._region_interior(start)
        )
        return IntervalRealization(
            start_ql=start,
            note_end_ql=end,
            next_onset_ql=next_onset,
            note=note_span.notation,
            rest=rest_span.notation if rest_span else None,
            cost=best[0][0],
            offset_cost=offset_cost,
            strong_boundary_obscured=note_span.strong_boundary_obscured
            + (rest_span.strong_boundary_obscured if rest_span else 0),
            weak_boundary_obscured=note_span.weak_boundary_obscured
            + (rest_span.weak_boundary_obscured if rest_span else 0),
            raw_overlap_ql=overlap,
            tuplet_group_count=groups,
            tuplet_atom_count=note_span.tuplet_atom_count
            + (rest_span.tuplet_atom_count if rest_span else 0),
            triplet_group_continuation=continuation,
        )

    def realize_path(
        self,
        positions: tuple[Fraction, ...],
        notes: tuple[NormalizedNote, ...],
    ) -> tuple[IntervalRealization, ...]:
        """Interval realization per note along a committed onset path.

        Entry ``i`` realizes ``[positions[i], positions[i+1])``; the final
        note uses its raw-offset neighborhood (``next_onset=None``, the
        phrase-end candidates of design 32 step 5). Committed paths are
        realizable by construction — an unrealizable interval here means a
        bug upstream, so it raises ``AssertionError``.
        """
        if len(positions) != len(notes):
            raise ValueError(
                f"positions/notes length mismatch: {len(positions)} != {len(notes)}"
            )
        out: list[IntervalRealization] = []
        for i, note in enumerate(notes):
            nxt = positions[i + 1] if i + 1 < len(positions) else None
            interval = self.interval(positions[i], nxt, note)
            if interval is None:
                raise AssertionError(
                    f"committed interval [{positions[i]}, {nxt}) is not realizable"
                )
            out.append(interval)
        return tuple(out)


def realize_interval(
    start_ql: Fraction,
    next_onset_ql: Fraction | None,
    observed_offset_ql: float,
    meter: MeterMap | MetricalTree,
    *,
    profile: QuantizationProfile | None = None,
    confidence: float | None = None,
    realizer: SpanRealizer | None = None,
    triplet_regions: tuple[TripletRegion, ...] = (),
) -> IntervalRealization | None:
    """Realize one onset interval into note + optional rest (design 12).

    Convenience wrapper matching the issue-level entry point
    ``realize_interval(start, next_onset, observed_offset, meter_tree)``:
    ``meter`` accepts a :class:`MeterMap` (full maps, including meter
    changes) or a bare :class:`MetricalTree`, which is wrapped as an
    indefinite map from position 0. ``next_onset_ql=None`` realizes the
    phrase-final note from its raw-offset neighborhood.

    Pass a shared ``realizer`` to reuse its memoization caches across calls;
    otherwise one is created for the call (``triplet_regions`` enables
    triplet atoms inside the given beats). Returns ``None`` when the
    interval cannot be written with the enabled atom vocabulary.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    if isinstance(meter, MetricalTree):
        meter_map: MeterMap = MeterMap(
            (MeterSegment(Fraction(0), meter.numerator, meter.denominator),)
        )
    elif isinstance(meter, MeterMap):
        meter_map = meter
    else:
        raise TypeError(f"meter must be a MeterMap or MetricalTree, got {meter!r}")
    if realizer is None:
        realizer = SpanRealizer(meter_map, profile, triplet_regions=triplet_regions)
    note = NormalizedNote(
        # Placeholder id — interval realization never reads source identity.
        source_id=RawNoteEventId("rne-000000"),
        pitch_midi=0,
        onset_ql=float(start_ql),
        offset_ql=observed_offset_ql,
        confidence=confidence,
    )
    return realizer.interval(start_ql, next_onset_ql, note)


__all__ = [
    "TINY_REST_MAX_QL",
    "AtomSpec",
    "IntervalRealization",
    "SpanDecomposition",
    "SpanRealizer",
    "atom_vocabulary",
    "realize_interval",
]
