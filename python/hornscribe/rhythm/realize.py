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
tiny-rest`` penalties (the ``tie`` term applies to every atom after the
first in a note span — a multi-atom note pays one tie per junction).
A note atom "obscures" an interior boundary strictly stronger than
its own start — a quarter note starting on the "and" of a beat hides the next
beat boundary and pays ``strong_boundary_crossing``; the tied eighth+eighth
decomposition then wins when the cost prefers it (design 15).

Multi-atom note spans tie their atoms (barline/beat splits); rest spans
produce separate rests which never tie (design 16). A complete empty measure
is always a single whole rest, regardless of meter (standard notation rule).

Monophonic rules (design 13, 26, 27):

* ``e <= q`` always — raw offsets overrunning the next onset are clipped and
  the overrun amount is reported through diagnostics;
* distinct input events are never merged — repeated same-pitch tongued notes
  each keep their own note boundary;
* candidate ends are ``{q}`` (sustain to the next onset) plus the grid points
  neighboring the raw offset (design 12).

Piece decompositions are memoized on ``(meter, grid, local start, duration,
is_rest)`` — identical metrical spans recur constantly inside a run
(design 43); the hit/call counters are surfaced through
:class:`QuantizationDiagnostics`.
"""

from __future__ import annotations

import math
from bisect import bisect_left
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


@dataclass(frozen=True)
class _DPState:
    """Partial decomposition ending at one boundary position."""

    cost: float
    atoms: tuple[RhythmAtom, ...]
    strong: int
    weak: int
    tiny: int
    dots2: int

    @property
    def key(self) -> tuple[float, int, tuple[Fraction, ...]]:
        """Deterministic decomposition order (design 44): cost, then fewer
        symbols, then lexicographic duration sequence."""
        return (self.cost, len(self.atoms), tuple(a.duration_ql for a in self.atoms))


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
    """

    def __init__(self, meter_map: MeterMap, profile: QuantizationProfile) -> None:
        self._meter_map = meter_map
        self._profile = profile
        self._weights = profile.weights
        self._step = profile.min_note_value_ql
        self._vocab = atom_vocabulary(self._step)
        self._segment_starts = frozenset(s.start_ql for s in meter_map.segments)
        self._trees: dict[tuple[int, int], MetricalTree] = {}
        self._boundary: dict[tuple[int, int], _BoundaryInfo] = {}
        self._piece_cache: dict[
            tuple[tuple[int, int], Fraction, Fraction, bool], _PieceResult
        ] = {}
        self._interval_cache: dict[
            tuple[Fraction, Fraction | None, float, float | None], IntervalRealization
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

    # --- span decomposition (design 16) ---------------------------------------

    def _decompose_piece(
        self,
        segment: MeterSegment,
        local_start: Fraction,
        local_dur: Fraction,
        is_rest: bool,
    ) -> _PieceResult:
        """Memoized measure-local shortest-path decomposition."""
        key = (
            (segment.numerator, segment.denominator),
            local_start,
            local_dur,
            is_rest,
        )
        self.piece_calls += 1
        hit = self._piece_cache.get(key)
        if hit is not None:
            self.piece_cache_hits += 1
            return hit
        result = self._decompose_piece_uncached(segment, local_start, local_dur, is_rest)
        self._piece_cache[key] = result
        return result

    def _decompose_piece_uncached(
        self,
        segment: MeterSegment,
        local_start: Fraction,
        local_dur: Fraction,
        is_rest: bool,
    ) -> _PieceResult:
        tree = self._tree(segment)
        info = self._info(segment)
        weights = self._weights
        local_end = local_start + local_dur

        # A complete empty measure is written as a single whole rest in any
        # meter (standard notation convention, design 16).
        if is_rest and local_start == 0 and local_dur == tree.measure_length_ql:
            atom = RhythmAtom(local_dur, "whole", is_rest=True)
            return _PieceResult((atom,), weights.symbol, 0, 0, 0, 0)

        positions = sorted(
            {local_start, local_end}
            | {b for b in info.positions if local_start < b < local_end}
        )
        pos_set = frozenset(positions)

        best: dict[Fraction, _DPState] = {
            local_start: _DPState(0.0, (), 0, 0, 0, 0)
        }
        for pos in positions:
            state = best.get(pos)
            if state is None or pos == local_end:
                continue
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
                cand = _DPState(
                    cost=cost,
                    atoms=(*state.atoms, atom),
                    strong=state.strong + strong,
                    weak=state.weak + weak,
                    tiny=state.tiny + int(tiny),
                    dots2=state.dots2 + int(spec.dots == 2),
                )
                current = best.get(target)
                if current is None or cand.key < current.key:
                    best[target] = cand

        final = best.get(local_end)
        if final is None:
            # Unreachable: the minimum-value atom always tiles a grid span.
            raise AssertionError(
                f"no decomposition for span [{local_start}, {local_end}) in "
                f"{segment.numerator}/{segment.denominator}"
            )
        return _PieceResult(
            final.atoms, final.cost, final.strong, final.weak, final.tiny, final.dots2
        )

    def realize_span(
        self, start_ql: Fraction, end_ql: Fraction, *, is_rest: bool
    ) -> SpanDecomposition:
        """Decompose ``[start_ql, end_ql)`` into atoms (design 16).

        The span is cut at every interior barline and meter-change boundary;
        each piece is decomposed in its own measure-local metrical tree, so
        atoms never cross a barline. Note spans (``is_rest=False``) join
        their atoms with ties; rest spans never tie.
        """
        start = as_exact_fraction(start_ql, name="start_ql")
        end = as_exact_fraction(end_ql, name="end_ql")
        if end <= start:
            raise ValueError(f"empty span: [{start}, {end})")

        cuts = self._split_points(start, end)
        atoms: list[RhythmAtom] = []
        cost = 0.0
        strong = weak = tiny = dots2 = 0
        for piece_start, piece_end in pairwise((start, *cuts, end)):
            segment = self._meter_map.segment_at(piece_start)
            local_start = segment.measure_offset_ql(piece_start)
            piece = self._decompose_piece(
                segment, local_start, piece_end - piece_start, is_rest
            )
            atoms.extend(piece.atoms)
            cost += piece.cost
            strong += piece.strong
            weak += piece.weak
            tiny += piece.tiny
            dots2 += piece.dots2
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
        )

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
        ``e <= q`` rule holds by construction (design 27).
        """
        neighbors = _TAIL_END_NEIGHBORS if next_onset is None else _INTERIOR_END_NEIGHBORS
        ends = {next_onset} if next_onset is not None else set()
        k0 = nearest_grid_index(offset_ql, self._step)
        for dk in range(-neighbors, neighbors + 1):
            ends.add(Fraction(k0 + dk) * self._step)
        lo = start + self._step
        out = sorted(
            e for e in ends if e >= lo and (next_onset is None or e <= next_onset)
        )
        if not out:
            # Reversed/degenerate raw offset (design 38): hold to the next
            # onset, or to one grid step for the phrase-final note.
            out = [next_onset] if next_onset is not None else [lo]
        return tuple(out)

    def interval(
        self,
        start_ql: Fraction,
        next_onset_ql: Fraction | None,
        note: NormalizedNote,
    ) -> IntervalRealization:
        """Realize one transition interval; memoized per (p, q, z, confidence)."""
        start = as_exact_fraction(start_ql, name="start_ql")
        nxt = (
            None
            if next_onset_ql is None
            else as_exact_fraction(next_onset_ql, name="next_onset_ql")
        )
        key = (start, nxt, note.offset_ql, note.confidence)
        self.interval_calls += 1
        hit = self._interval_cache.get(key)
        if hit is not None:
            self.interval_cache_hits += 1
            return hit
        result = self._interval_uncached(start, nxt, note.offset_ql, note.confidence)
        self._interval_cache[key] = result
        return result

    def _interval_uncached(
        self,
        start: Fraction,
        next_onset: Fraction | None,
        offset_ql: float,
        confidence: float | None,
    ) -> IntervalRealization:
        weights = self._weights
        profile = self._profile
        w = confidence_weight(confidence)
        best: tuple[
            tuple[float, int, int, Fraction],
            Fraction,
            float,
            SpanDecomposition,
            SpanDecomposition | None,
        ] | None = None
        for end in self._candidate_ends(start, next_onset, offset_ql):
            offset_cost = (
                w
                * weights.offset
                * huber(
                    (float(end) - offset_ql) / profile.sigma_offset_ql, profile.huber_k
                )
            )
            note_span = self.realize_span(start, end, is_rest=False)
            rest_span = (
                self.realize_span(end, next_onset, is_rest=True)
                if next_onset is not None and end < next_onset
                else None
            )
            cost = offset_cost + note_span.cost + (rest_span.cost if rest_span else 0.0)
            symbols = len(note_span.atoms) + (
                len(rest_span.atoms) if rest_span else 0
            )
            # Design 44 order: cost, then fewer symbols, then fewer ties,
            # then lexical position (earlier end wins a full tie).
            key = (cost, symbols, len(note_span.atoms) - 1, end)
            if best is None or key < best[0]:
                best = (key, end, offset_cost, note_span, rest_span)
        assert best is not None  # candidate set is never empty
        _, end, offset_cost, note_span, rest_span = best
        overlap = (
            max(0.0, offset_ql - float(next_onset)) if next_onset is not None else 0.0
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
        )

    def realize_path(
        self,
        positions: tuple[Fraction, ...],
        notes: tuple[NormalizedNote, ...],
    ) -> tuple[IntervalRealization, ...]:
        """Interval realization per note along a committed onset path.

        Entry ``i`` realizes ``[positions[i], positions[i+1])``; the final
        note uses its raw-offset neighborhood (``next_onset=None``, the
        phrase-end candidates of design 32 step 5).
        """
        if len(positions) != len(notes):
            raise ValueError(
                f"positions/notes length mismatch: {len(positions)} != {len(notes)}"
            )
        out: list[IntervalRealization] = []
        for i, note in enumerate(notes):
            nxt = positions[i + 1] if i + 1 < len(positions) else None
            out.append(self.interval(positions[i], nxt, note))
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
) -> IntervalRealization:
    """Realize one onset interval into note + optional rest (design 12).

    Convenience wrapper matching the issue-level entry point
    ``realize_interval(start, next_onset, observed_offset, meter_tree)``:
    ``meter`` accepts a :class:`MeterMap` (full maps, including meter
    changes) or a bare :class:`MetricalTree`, which is wrapped as an
    indefinite map from position 0. ``next_onset_ql=None`` realizes the
    phrase-final note from its raw-offset neighborhood.

    Pass a shared ``realizer`` to reuse its memoization caches across calls;
    otherwise one is created for the call.
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
        realizer = SpanRealizer(meter_map, profile)
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
