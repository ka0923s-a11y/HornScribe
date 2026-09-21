"""QNT-001: MeterSegment / MeterMap / MetricalTree contracts (design 5.3, 7, 22, 28)."""

from __future__ import annotations

from fractions import Fraction
from itertools import pairwise

import pytest

from hornscribe.domain.score import TimeSignature
from hornscribe.rhythm import (
    MeterError,
    MeterMap,
    MeterMapError,
    MeterSegment,
    MetricalLevel,
    MetricalNode,
    MetricalTree,
    UnsupportedMeterError,
)

# --- MeterSegment ----------------------------------------------------------------


def test_meter_segment_measure_lengths() -> None:
    assert MeterSegment(Fraction(0), 4, 4).measure_length_ql == Fraction(4)
    assert MeterSegment(Fraction(0), 3, 4).measure_length_ql == Fraction(3)
    assert MeterSegment(Fraction(0), 2, 4).measure_length_ql == Fraction(2)
    assert MeterSegment(Fraction(0), 6, 8).measure_length_ql == Fraction(3)


def test_meter_segment_compound_beat() -> None:
    seg = MeterSegment(Fraction(0), 6, 8)
    assert seg.is_compound
    assert seg.beat_count == 2
    assert seg.beat_unit_ql == Fraction(3, 2)
    simple = MeterSegment(Fraction(0), 4, 4)
    assert not simple.is_compound
    assert simple.beat_count == 4
    assert simple.beat_unit_ql == Fraction(1)


def test_meter_segment_time_signature_round_trip() -> None:
    seg = MeterSegment(Fraction(0), 6, 8)
    assert seg.time_signature == TimeSignature(beats_per_measure=6, beat_unit=8)


def test_meter_segment_validation() -> None:
    with pytest.raises(MeterError, match="numerator"):
        MeterSegment(Fraction(0), 0, 4)
    with pytest.raises(MeterError, match="power of two"):
        MeterSegment(Fraction(0), 4, 3)
    with pytest.raises(MeterError, match="start_ql"):
        MeterSegment(Fraction(-1), 4, 4)
    with pytest.raises(MeterError, match="measure_phase_ql"):
        MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(4))
    with pytest.raises(TypeError, match="exact Fraction"):
        MeterSegment(0.0, 4, 4, measure_phase_ql=Fraction(0))  # type: ignore[arg-type]
    # int is exact and accepted
    assert MeterSegment(0, 4, 4).start_ql == Fraction(0)  # type: ignore[arg-type]


def test_meter_segment_measure_offset_and_index() -> None:
    # one-beat pickup in 4/4: segment starts at measure offset 3
    seg = MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(3))
    assert seg.measure_offset_ql(Fraction(0)) == Fraction(3)
    assert seg.measure_offset_ql(Fraction(1)) == Fraction(0)  # first downbeat
    assert seg.measure_offset_ql(Fraction(5)) == Fraction(0)  # second downbeat
    assert seg.measure_index(Fraction(0)) == 0  # incomplete pickup measure
    assert seg.measure_index(Fraction(1)) == 1
    assert seg.measure_index(Fraction(5)) == 2


# --- MeterMap --------------------------------------------------------------------


def test_meter_map_segment_at() -> None:
    meter_map = MeterMap(
        (MeterSegment(Fraction(0), 4, 4), MeterSegment(Fraction(8), 3, 4))
    )
    assert meter_map.segment_at(Fraction(0)).numerator == 4
    assert meter_map.segment_at(Fraction(7, 2)).numerator == 4
    assert meter_map.segment_at(Fraction(8)).numerator == 3  # change takes effect
    assert meter_map.segment_at(Fraction(100)).numerator == 3  # last extends


def test_meter_map_sorts_and_validates() -> None:
    meter_map = MeterMap(
        (MeterSegment(Fraction(8), 3, 4), MeterSegment(Fraction(0), 4, 4))
    )
    assert meter_map.segments[0].numerator == 4
    with pytest.raises(MeterMapError, match="at least one"):
        MeterMap(())
    with pytest.raises(MeterMapError, match="strictly increase"):
        MeterMap((MeterSegment(Fraction(4), 4, 4), MeterSegment(Fraction(4), 3, 4)))


def test_meter_map_precedes_first_segment() -> None:
    meter_map = MeterMap((MeterSegment(Fraction(4), 4, 4),))
    with pytest.raises(MeterMapError, match="precedes"):
        meter_map.segment_at(Fraction(0))


def test_meter_map_measure_offset_uses_active_segment() -> None:
    meter_map = MeterMap(
        (MeterSegment(Fraction(0), 4, 4), MeterSegment(Fraction(8), 6, 8))
    )
    assert meter_map.measure_offset_ql(Fraction(9)) == Fraction(1)  # 3/4->? no: 6/8 L=3
    assert meter_map.measure_index(Fraction(9)) == 0


def test_measure_boundaries_plain() -> None:
    meter_map = MeterMap((MeterSegment(Fraction(0), 4, 4),))
    assert meter_map.measure_boundaries(Fraction(0), Fraction(12)) == (
        Fraction(0),
        Fraction(4),
        Fraction(8),
    )


def test_measure_boundaries_with_pickup_phase() -> None:
    meter_map = MeterMap(
        (MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(3)),)
    )
    # one-beat pickup: downbeats land at 1, 5, 9, 13, ...
    assert meter_map.measure_boundaries(Fraction(0), Fraction(12)) == (
        Fraction(1),
        Fraction(5),
        Fraction(9),
    )


def test_measure_boundaries_across_meter_change() -> None:
    meter_map = MeterMap(
        (MeterSegment(Fraction(0), 4, 4), MeterSegment(Fraction(8), 3, 4))
    )
    assert meter_map.measure_boundaries(Fraction(0), Fraction(18)) == (
        Fraction(0),
        Fraction(4),
        Fraction(8),
        Fraction(11),
        Fraction(14),
        Fraction(17),
    )


def test_measure_boundaries_rejects_empty_range() -> None:
    meter_map = MeterMap((MeterSegment(Fraction(0), 4, 4),))
    with pytest.raises(MeterMapError, match="empty range"):
        meter_map.measure_boundaries(Fraction(4), Fraction(4))


# --- MetricalTree ----------------------------------------------------------------


def test_44_tree_positions() -> None:
    """Acceptance: 4/4 measure/beat/subdivision positions are correct."""
    tree = MetricalTree(4, 4)
    assert tree.measure_length_ql == Fraction(4)
    assert tree.beat_count == 4
    assert tree.beat_positions_ql == (Fraction(0), Fraction(1), Fraction(2), Fraction(3))
    # half-measure grouping (design 7.1)
    assert tree.positions_at_level(MetricalLevel.BEAT_GROUP) == (
        Fraction(0),
        Fraction(2),
    )
    # finest default grid = sixteenths
    assert tree.leaf_positions_ql == tuple(Fraction(i, 4) for i in range(16))
    # boundary strengths
    assert tree.boundary_level(Fraction(0)) is MetricalLevel.MEASURE
    assert tree.boundary_level(Fraction(4)) is MetricalLevel.MEASURE
    assert tree.boundary_level(Fraction(2)) is MetricalLevel.BEAT_GROUP
    assert tree.boundary_level(Fraction(1)) is MetricalLevel.BEAT
    assert tree.boundary_level(Fraction(1, 2)) is MetricalLevel.SUBDIVISION
    assert tree.boundary_level(Fraction(1, 8)) is None  # off the 1/4 grid
    assert tree.boundary_depth(Fraction(0)) == 0
    assert tree.boundary_depth(Fraction(2)) == 1
    assert tree.boundary_depth(Fraction(1)) == 2
    assert tree.boundary_depth(Fraction(1, 2)) == 3


def test_34_tree() -> None:
    tree = MetricalTree(3, 4)
    assert tree.measure_length_ql == Fraction(3)
    assert tree.beat_positions_ql == (Fraction(0), Fraction(1), Fraction(2))
    assert tree.positions_at_level(MetricalLevel.BEAT_GROUP) == ()
    assert tree.leaf_positions_ql == tuple(Fraction(i, 4) for i in range(12))


def test_24_tree() -> None:
    tree = MetricalTree(2, 4)
    assert tree.measure_length_ql == Fraction(2)
    assert tree.beat_positions_ql == (Fraction(0), Fraction(1))
    assert tree.leaf_positions_ql == tuple(Fraction(i, 4) for i in range(8))


def test_68_compound_structure() -> None:
    """Acceptance: 6/8 = two compound beats of 1.5 ql; ternary is native."""
    tree = MetricalTree(6, 8)
    assert tree.measure_length_ql == Fraction(3)
    assert tree.beat_count == 2
    beats = tree.nodes_at_level(MetricalLevel.BEAT)
    assert tuple(b.start_ql for b in beats) == (Fraction(0), Fraction(3, 2))
    assert all(b.duration_ql == Fraction(3, 2) for b in beats)
    for beat in beats:
        assert len(beat.children) == 3
        for eighth in beat.children:
            assert eighth.duration_ql == Fraction(1, 2)
            assert eighth.division == 3
            assert eighth.level is MetricalLevel.SUBDIVISION
            assert not eighth.is_tuplet  # native ternary, never a tuplet
    # no node anywhere in the tree is a tuplet
    assert all(not n.is_tuplet for n in tree.iter_nodes())
    assert tree.boundary_level(Fraction(3, 2)) is MetricalLevel.BEAT
    assert tree.boundary_level(Fraction(1, 2)) is MetricalLevel.SUBDIVISION
    # sixteenth grid: each eighth binary-splits
    assert tree.leaf_positions_ql == tuple(Fraction(i, 4) for i in range(12))


def test_children_tile_parent_span() -> None:
    for tree in (
        MetricalTree(4, 4),
        MetricalTree(3, 4),
        MetricalTree(2, 4),
        MetricalTree(6, 8),
    ):
        for node in tree.iter_nodes():
            if not node.children:
                continue
            assert node.children[0].start_ql == node.start_ql
            assert sum((c.duration_ql for c in node.children), Fraction(0)) == (
                node.duration_ql
            )
            for left, right in pairwise(node.children):
                assert left.end_ql == right.start_ql
            assert node.children[-1].end_ql == node.end_ql


def test_positions_are_exact_fractions() -> None:
    """Acceptance: meter positions use exact Fraction where symbolic."""
    for tree in (MetricalTree(4, 4), MetricalTree(6, 8)):
        for node in tree.iter_nodes():
            assert isinstance(node.start_ql, Fraction)
            assert isinstance(node.duration_ql, Fraction)


def test_min_note_value_limits_depth() -> None:
    tree = MetricalTree(4, 4, min_note_value_ql=Fraction(1, 2))
    assert tree.leaf_positions_ql == tuple(Fraction(i, 2) for i in range(8))
    tree68 = MetricalTree(6, 8, min_note_value_ql=Fraction(1, 2))
    assert tree68.leaf_positions_ql == tuple(Fraction(i, 2) for i in range(6))


def test_unsupported_meter_fails_clearly() -> None:
    for numerator, denominator in ((5, 4), (7, 8), (9, 8), (12, 8), (3, 8)):
        with pytest.raises(UnsupportedMeterError, match="unsupported meter"):
            MetricalTree(numerator, denominator)


def test_tree_constructors() -> None:
    assert MetricalTree.for_meter(6, 8).beat_count == 2
    assert MetricalTree.from_time_signature(TimeSignature(3, 4)).beat_count == 3
    segment = MeterSegment(Fraction(0), 2, 4)
    assert MetricalTree.for_segment(segment).measure_length_ql == Fraction(2)


def test_boundary_outside_measure_fails() -> None:
    tree = MetricalTree(4, 4)
    with pytest.raises(MeterError, match="outside measure"):
        tree.boundary_level(Fraction(5))


def test_boundary_positions_include_measure_end() -> None:
    tree = MetricalTree(2, 4)
    positions = tree.boundary_positions_ql
    assert positions[0] == Fraction(0)
    assert positions[-1] == Fraction(2)


def test_metrical_node_is_leaf() -> None:
    tree = MetricalTree(2, 4)
    assert not tree.root.is_leaf
    assert all(n.is_leaf for n in tree.leaf_nodes)
    root: MetricalNode = tree.root
    assert root.level is MetricalLevel.MEASURE
    assert root.division == 1
