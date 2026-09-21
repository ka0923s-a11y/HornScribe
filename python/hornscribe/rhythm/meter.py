"""Meter segments, meter maps, and metrical trees (QUANTIZER_DESIGN.md 5.3, 7).

* :class:`MeterSegment` — one meter active from ``start_ql`` forward over a
  beat range (until the next segment in a :class:`MeterMap`).
* :class:`MeterMap` — validated, ordered meter segments covering the score
  timeline.
* :class:`MetricalTree` — the hierarchical measure structure the quantizer
  uses instead of a flat grid (design section 7): measure -> beat groups ->
  beats -> subdivisions, with exact :class:`~fractions.Fraction` positions.

Supported HSQ-v1 meters: 4/4, 3/4, 2/4, 6/8 (design section 28). In 6/8 the
two compound beats of ``3/2`` ql each split into three eighths of ``1/2`` ql —
that native ternary subdivision is meter structure, *never* a tuplet, so it
carries ``is_tuplet=False`` and receives no tuplet penalty (design 7.3).
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import Enum
from fractions import Fraction
from itertools import pairwise

from hornscribe.domain.score import TimeSignature
from hornscribe.rhythm._util import as_exact_fraction


class MeterError(ValueError):
    """Base class for meter contract violations."""


class UnsupportedMeterError(MeterError):
    """Meter outside the HSQ-v1 supported set (4/4, 3/4, 2/4, 6/8)."""


class MeterMapError(MeterError):
    """Invalid meter map, or a position outside the map's coverage."""


def _is_power_of_two(value: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0 and (
        value & (value - 1)
    ) == 0


_SUPPORTED_METERS: tuple[tuple[int, int], ...] = ((4, 4), (3, 4), (2, 4), (6, 8))


@dataclass(frozen=True)
class MeterSegment:
    """One meter active over a beat range (design section 5.3).

    The segment applies to score positions ``pos >= start_ql`` until the next
    segment's ``start_ql`` inside a :class:`MeterMap` (or indefinitely when it
    is the last segment).

    ``measure_phase_ql`` is the metrical offset of ``start_ql`` inside its
    measure cycle — the mechanism behind pickup/anacrusis handling (design
    section 22). ``0`` means ``start_ql`` is a downbeat. A one-quarter pickup
    in 4/4 is ``measure_phase_ql=Fraction(3)``: position ``0`` then sits at
    measure offset ``3`` and the first downbeat falls 1 ql later.
    """

    start_ql: Fraction
    numerator: int
    denominator: int
    measure_phase_ql: Fraction = Fraction(0)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "start_ql", as_exact_fraction(self.start_ql, name="start_ql")
        )
        object.__setattr__(
            self,
            "measure_phase_ql",
            as_exact_fraction(self.measure_phase_ql, name="measure_phase_ql"),
        )
        if self.start_ql < 0:
            raise MeterError(f"start_ql must be >= 0, got {self.start_ql}")
        if (
            isinstance(self.numerator, bool)
            or not isinstance(self.numerator, int)
            or self.numerator < 1
        ):
            raise MeterError(f"numerator must be a positive int, got {self.numerator!r}")
        if not _is_power_of_two(self.denominator):
            raise MeterError(
                f"denominator must be a positive power of two, got {self.denominator!r}"
            )
        if not 0 <= self.measure_phase_ql < self.measure_length_ql:
            raise MeterError(
                f"measure_phase_ql must be in [0, {self.measure_length_ql}), "
                f"got {self.measure_phase_ql}"
            )

    @property
    def measure_length_ql(self) -> Fraction:
        """Length of one measure in quarterLength (4/4 -> 4, 6/8 -> 3)."""
        return Fraction(self.numerator * 4, self.denominator)

    @property
    def is_compound(self) -> bool:
        """Compound meter (beat subdivides natively by three): 6/8, 9/8, 12/8."""
        return self.numerator % 3 == 0 and self.numerator > 3

    @property
    def beat_count(self) -> int:
        """Number of primary beats per measure (6/8 -> 2 compound beats)."""
        if self.is_compound:
            return self.numerator // 3
        return self.numerator

    @property
    def beat_unit_ql(self) -> Fraction:
        """Duration of one primary beat (6/8 -> ``3/2`` ql dotted quarter)."""
        return self.measure_length_ql / self.beat_count

    @property
    def time_signature(self) -> TimeSignature:
        """This segment's meter as a domain :class:`TimeSignature`."""
        return TimeSignature(beats_per_measure=self.numerator, beat_unit=self.denominator)

    def measure_offset_ql(self, pos_ql: Fraction) -> Fraction:
        """Position of ``pos_ql`` inside the measure cycle, in ``[0, L)``."""
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        return (pos - self.start_ql + self.measure_phase_ql) % self.measure_length_ql

    def measure_index(self, pos_ql: Fraction) -> int:
        """Zero-based index of the measure containing ``pos_ql``.

        With a pickup (``measure_phase_ql > 0``) the incomplete first measure
        is index ``0``.
        """
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        return (pos - self.start_ql + self.measure_phase_ql) // self.measure_length_ql


@dataclass(frozen=True)
class MeterMap:
    """Ordered meter segments covering the score timeline.

    Segment ``i`` is active for ``segments[i].start_ql <= pos <
    segments[i+1].start_ql``; the last segment extends indefinitely.
    Segments are stored sorted by ``start_ql`` and must be strictly
    increasing — overlapping or duplicate starts raise :class:`MeterMapError`.
    """

    segments: tuple[MeterSegment, ...]
    _starts: tuple[Fraction, ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        segments = tuple(sorted(self.segments, key=lambda s: s.start_ql))
        object.__setattr__(self, "segments", segments)
        if not segments:
            raise MeterMapError("meter map needs at least one segment")
        for prev, cur in pairwise(segments):
            if cur.start_ql <= prev.start_ql:
                raise MeterMapError(
                    "meter segment starts must strictly increase: "
                    f"{prev.start_ql} !< {cur.start_ql}"
                )
        object.__setattr__(self, "_starts", tuple(s.start_ql for s in segments))

    def __len__(self) -> int:
        return len(self.segments)

    def segment_at(self, pos_ql: Fraction) -> MeterSegment:
        """The segment active at ``pos_ql``.

        Raises :class:`MeterMapError` for positions before the first segment.
        """
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        i = bisect_right(self._starts, pos) - 1
        if i < 0:
            raise MeterMapError(
                f"position {pos} precedes first meter segment at {self._starts[0]}"
            )
        return self.segments[i]

    def measure_offset_ql(self, pos_ql: Fraction) -> Fraction:
        """Position of ``pos_ql`` inside the active measure cycle."""
        return self.segment_at(pos_ql).measure_offset_ql(pos_ql)

    def measure_index(self, pos_ql: Fraction) -> int:
        """Zero-based index of the measure containing ``pos_ql``."""
        return self.segment_at(pos_ql).measure_index(pos_ql)

    def measure_boundaries(
        self, start_ql: Fraction, end_ql: Fraction
    ) -> tuple[Fraction, ...]:
        """Downbeat positions in ``[start_ql, end_ql)`` across all segments.

        Handles mid-map meter changes and pickup phases; positions are exact
        ``Fraction`` values.
        """
        lo = as_exact_fraction(start_ql, name="start_ql")
        hi = as_exact_fraction(end_ql, name="end_ql")
        if hi <= lo:
            raise MeterMapError(f"empty range: [{lo}, {hi})")
        out: list[Fraction] = []
        for i, seg in enumerate(self.segments):
            seg_end = self.segments[i + 1].start_ql if i + 1 < len(self.segments) else hi
            seg_lo = max(lo, seg.start_ql)
            seg_hi = min(hi, seg_end)
            if seg_hi <= seg_lo:
                continue
            length = seg.measure_length_ql
            # downbeats satisfy (pos - start + phase) == 0 (mod L)
            base = seg.start_ql - seg.measure_phase_ql
            k = -((base - seg_lo) // length)  # ceil((seg_lo - base) / L)
            pos = base + k * length
            while pos < seg_hi:
                out.append(pos)
                pos += length
        return tuple(out)


class MetricalLevel(Enum):
    """Structural level of a :class:`MetricalNode`."""

    MEASURE = "measure"
    BEAT_GROUP = "beat_group"
    """Intermediate grouping, e.g. the two half-measures of 4/4."""
    BEAT = "beat"
    """Primary beat; the compound ``3/2`` ql beat in 6/8."""
    SUBDIVISION = "subdivision"


@dataclass(frozen=True)
class MetricalNode:
    """One node in a :class:`MetricalTree`.

    ``start_ql``/``duration_ql`` are exact, measure-local positions.
    ``division`` records the arity of the parent split that created this
    node (``1`` for the root). ``is_tuplet`` is ``True`` only for nodes
    created by a *tuplet* division — native subdivisions (including the
    three-way eighth split in 6/8) always carry ``False`` (design 7.3).
    """

    start_ql: Fraction
    duration_ql: Fraction
    level: MetricalLevel
    depth: int
    division: int
    is_tuplet: bool
    children: tuple[MetricalNode, ...] = ()

    @property
    def end_ql(self) -> Fraction:
        """End of this node's span (measure-local, exclusive)."""
        return self.start_ql + self.duration_ql

    @property
    def is_leaf(self) -> bool:
        return not self.children


def _binary_children(
    start: Fraction, duration: Fraction, depth: int, min_value: Fraction
) -> tuple[MetricalNode, ...]:
    """Two half-size subdivision children, or none once below ``min_value``."""
    if duration / 2 < min_value:
        return ()
    half = duration / 2
    return (
        _subdivision(start, half, depth, 2, min_value),
        _subdivision(start + half, half, depth, 2, min_value),
    )


def _subdivision(
    start: Fraction, duration: Fraction, depth: int, division: int, min_value: Fraction
) -> MetricalNode:
    """A subdivision node that binary-splits further while >= ``min_value``."""
    return MetricalNode(
        start_ql=start,
        duration_ql=duration,
        level=MetricalLevel.SUBDIVISION,
        depth=depth,
        division=division,
        is_tuplet=False,
        children=_binary_children(start, duration, depth + 1, min_value),
    )


def _beat(
    start: Fraction, duration: Fraction, depth: int, division: int, min_value: Fraction
) -> MetricalNode:
    """A primary beat with binary subdivision children down to ``min_value``."""
    return MetricalNode(
        start_ql=start,
        duration_ql=duration,
        level=MetricalLevel.BEAT,
        depth=depth,
        division=division,
        is_tuplet=False,
        children=_binary_children(start, duration, depth + 1, min_value),
    )


def _build_compound_68(length: Fraction, min_value: Fraction) -> MetricalNode:
    """6/8: two compound beats of ``3/2`` ql, each three eighths of ``1/2`` ql."""
    beat_dur = length / 2  # Fraction(3, 2)
    eighth_dur = beat_dur / 3  # Fraction(1, 2)
    beats: list[MetricalNode] = []
    for i in range(2):
        beat_start = beat_dur * i
        children: tuple[MetricalNode, ...] = ()
        if eighth_dur >= min_value:
            children = tuple(
                _subdivision(beat_start + eighth_dur * j, eighth_dur, 2, 3, min_value)
                for j in range(3)
            )
        beats.append(
            MetricalNode(beat_start, beat_dur, MetricalLevel.BEAT, 1, 2, False, children)
        )
    return MetricalNode(Fraction(0), length, MetricalLevel.MEASURE, 0, 1, False, tuple(beats))


def _build_root(numerator: int, denominator: int, min_value: Fraction) -> MetricalNode:
    length = Fraction(numerator * 4, denominator)
    if (numerator, denominator) == (6, 8):
        return _build_compound_68(length, min_value)

    # Simple meters 4/4, 3/4, 2/4: quarter-note beats, binary subdivisions.
    beat_dur = Fraction(4, denominator)

    def beat(index: int, depth: int) -> MetricalNode:
        return _beat(Fraction(index) * beat_dur, beat_dur, depth, 2, min_value)

    if (numerator, denominator) == (4, 4):
        # Half-measure grouping (design 7.1): measure -> 2 groups -> 2 beats.
        groups = tuple(
            MetricalNode(
                Fraction(2) * g,
                Fraction(2),
                MetricalLevel.BEAT_GROUP,
                1,
                2,
                False,
                (beat(2 * g, 2), beat(2 * g + 1, 2)),
            )
            for g in range(2)
        )
        return MetricalNode(
            Fraction(0), length, MetricalLevel.MEASURE, 0, 1, False, groups
        )

    beats = tuple(
        MetricalNode(
            Fraction(i) * beat_dur,
            beat_dur,
            MetricalLevel.BEAT,
            1,
            numerator,
            False,
            _binary_children(Fraction(i) * beat_dur, beat_dur, 2, min_value),
        )
        for i in range(numerator)
    )
    return MetricalNode(Fraction(0), length, MetricalLevel.MEASURE, 0, 1, False, beats)


@dataclass(frozen=True)
class MetricalTree:
    """Hierarchical meter structure of one measure (design section 7).

    Supported HSQ-v1 meters: ``4/4``, ``3/4``, ``2/4``, ``6/8``; anything else
    raises :class:`UnsupportedMeterError` (odd meters arrive with custom
    grouping in v1+, design section 28).

    ``min_note_value_ql`` bounds the finest subdivision level — default
    ``Fraction(1, 4)`` = sixteenth note (design 8.1). Structural levels
    (measure / beat group / beat) always exist; only subdivisions are gated.

    All positions are exact ``Fraction`` offsets *within the measure*. Use
    :meth:`MeterSegment.measure_offset_ql` to map an absolute score position
    into the measure cycle.
    """

    numerator: int
    denominator: int
    min_note_value_ql: Fraction = Fraction(1, 4)
    root: MetricalNode = field(init=False, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "min_note_value_ql",
            as_exact_fraction(self.min_note_value_ql, name="min_note_value_ql"),
        )
        key = (self.numerator, self.denominator)
        if key not in _SUPPORTED_METERS:
            raise UnsupportedMeterError(
                f"unsupported meter {self.numerator}/{self.denominator}: "
                "HSQ-v1 supports 4/4, 3/4, 2/4 and 6/8"
            )
        length = Fraction(self.numerator * 4, self.denominator)
        if not 0 < self.min_note_value_ql <= length:
            raise MeterError(
                f"min_note_value_ql must be in (0, {length}], got {self.min_note_value_ql}"
            )
        object.__setattr__(
            self, "root", _build_root(self.numerator, self.denominator, self.min_note_value_ql)
        )

    @classmethod
    def for_meter(
        cls,
        numerator: int,
        denominator: int,
        min_note_value_ql: Fraction = Fraction(1, 4),
    ) -> MetricalTree:
        """Named constructor matching the design vocabulary."""
        return cls(numerator, denominator, min_note_value_ql)

    @classmethod
    def from_time_signature(
        cls, signature: TimeSignature, min_note_value_ql: Fraction = Fraction(1, 4)
    ) -> MetricalTree:
        """Build the tree for a domain :class:`TimeSignature`."""
        return cls(signature.beats_per_measure, signature.beat_unit, min_note_value_ql)

    @classmethod
    def for_segment(
        cls, segment: MeterSegment, min_note_value_ql: Fraction = Fraction(1, 4)
    ) -> MetricalTree:
        """Build the tree for the meter declared by a :class:`MeterSegment`."""
        return cls(segment.numerator, segment.denominator, min_note_value_ql)

    @property
    def measure_length_ql(self) -> Fraction:
        """Length of one measure in quarterLength."""
        return self.root.duration_ql

    @property
    def time_signature(self) -> TimeSignature:
        return TimeSignature(beats_per_measure=self.numerator, beat_unit=self.denominator)

    def iter_nodes(self) -> Iterator[MetricalNode]:
        """Yield every node, parents before children (pre-order DFS)."""
        stack = [self.root]
        while stack:
            node = stack.pop()
            yield node
            stack.extend(reversed(node.children))

    def nodes_at_level(self, level: MetricalLevel) -> tuple[MetricalNode, ...]:
        """All nodes at *level*, sorted by measure-local start."""
        return tuple(
            sorted((n for n in self.iter_nodes() if n.level is level), key=lambda n: n.start_ql)
        )

    def positions_at_level(self, level: MetricalLevel) -> tuple[Fraction, ...]:
        """Sorted measure-local start positions of the nodes at *level*."""
        return tuple(n.start_ql for n in self.nodes_at_level(level))

    @property
    def beat_positions_ql(self) -> tuple[Fraction, ...]:
        """Primary beat starts within the measure (6/8 -> ``(0, 3/2)``)."""
        return self.positions_at_level(MetricalLevel.BEAT)

    @property
    def beat_count(self) -> int:
        """Number of primary beats per measure (6/8 -> 2, not 6)."""
        return len(self.positions_at_level(MetricalLevel.BEAT))

    @property
    def leaf_nodes(self) -> tuple[MetricalNode, ...]:
        """Deepest nodes — the finest quantization grid, sorted by start."""
        return tuple(
            sorted((n for n in self.iter_nodes() if n.is_leaf), key=lambda n: n.start_ql)
        )

    @property
    def leaf_positions_ql(self) -> tuple[Fraction, ...]:
        """Measure-local grid positions at the finest subdivision level."""
        return tuple(n.start_ql for n in self.leaf_nodes)

    @property
    def boundary_positions_ql(self) -> tuple[Fraction, ...]:
        """All node start positions plus the measure end (the next downbeat)."""
        positions = {n.start_ql for n in self.iter_nodes()}
        positions.add(self.measure_length_ql)
        return tuple(sorted(positions))

    def boundary_level(self, pos_ql: Fraction) -> MetricalLevel | None:
        """Strongest metrical level whose boundary falls on ``pos_ql``.

        ``pos_ql`` is measure-local; ``0`` and ``measure_length_ql`` are
        :attr:`MetricalLevel.MEASURE`. Returns ``None`` for positions that do
        not coincide with any node boundary.
        """
        pos = self._checked_pos(pos_ql)
        if pos == self.measure_length_ql:
            return MetricalLevel.MEASURE
        best: MetricalNode | None = None
        for node in self.iter_nodes():
            if node.start_ql == pos and (best is None or node.depth < best.depth):
                best = node
        return None if best is None else best.level

    def boundary_depth(self, pos_ql: Fraction) -> int | None:
        """Shallowest tree depth whose boundary falls on ``pos_ql``.

        Smaller depth = stronger boundary (measure 0, beat group 1, ...).
        ``None`` for positions not on any node boundary.
        """
        pos = self._checked_pos(pos_ql)
        if pos == self.measure_length_ql:
            return 0
        depths = [n.depth for n in self.iter_nodes() if n.start_ql == pos]
        return min(depths) if depths else None

    def _checked_pos(self, pos_ql: Fraction) -> Fraction:
        pos = as_exact_fraction(pos_ql, name="pos_ql")
        if not 0 <= pos <= self.measure_length_ql:
            raise MeterError(
                f"position {pos} outside measure range [0, {self.measure_length_ql}]"
            )
        return pos
