"""QNT-001: TimeWarp / BeatAnchor / BeatMap contracts (QUANTIZER_DESIGN.md 5.2, 6)."""

from __future__ import annotations

import math
from fractions import Fraction

import pytest

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.rhythm import (
    BeatAnchor,
    BeatMap,
    BeatSource,
    InvalidBeatMapError,
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)

_TR = TranscriptionRevisionId("tr-" + "0" * 16)


def _anchor(t: float, ql: Fraction) -> BeatAnchor:
    return BeatAnchor(time_sec=t, score_pos_ql=ql)


# --- fixed-BPM mode (design 6.2) -------------------------------------------------


def test_fixed_120_bpm_maps_half_second_to_one_ql() -> None:
    """Acceptance: fixed 120 BPM maps 0.5 s -> 1.0 ql."""
    warp = TimeWarp.fixed_bpm(120.0)
    pos = warp.seconds_to_ql(0.5)
    assert pos == Fraction(1)
    assert isinstance(pos, Fraction)
    assert warp.seconds_to_ql(0.0) == Fraction(0)
    assert warp.seconds_to_ql(1.0) == Fraction(2)
    assert warp.seconds_to_ql(2.5) == Fraction(5)


def test_fixed_bpm_inverse() -> None:
    """Acceptance: inverse mapping ql -> seconds exists for fixed fixtures."""
    warp = TimeWarp.fixed_bpm(120.0)
    assert warp.ql_to_seconds(Fraction(1)) == 0.5
    assert warp.ql_to_seconds(Fraction(3, 2)) == 0.75
    assert warp.ql_to_seconds(Fraction(0)) == 0.0
    # round trip
    assert warp.ql_to_seconds(warp.seconds_to_ql(1.25)) == pytest.approx(1.25)


def test_fixed_bpm_zero_sec_offset() -> None:
    warp = TimeWarp.fixed_bpm(60.0, zero_sec=2.0)
    assert warp.seconds_to_ql(2.0) == Fraction(0)
    assert warp.seconds_to_ql(3.0) == Fraction(1)
    assert warp.ql_to_seconds(Fraction(1)) == 3.0


def test_fixed_bpm_extrapolates_linearly() -> None:
    """Acceptance: extrapolation — times before zero_sec map to negative ql."""
    warp = TimeWarp.fixed_bpm(120.0)
    assert warp.seconds_to_ql(-1.0) == Fraction(-2)
    assert warp.ql_to_seconds(Fraction(-2)) == -1.0


def test_fixed_bpm_rejects_invalid() -> None:
    for bad in (0.0, -120.0, math.inf, math.nan):
        with pytest.raises(ValueError):
            TimeWarp.fixed_bpm(bad)
    with pytest.raises(ValueError):
        TimeWarp.fixed_bpm(120.0, zero_sec=math.nan)


def test_fixed_bpm_mode_reported() -> None:
    warp = TimeWarp.fixed_bpm(100.0)
    assert warp.mode is TimeWarpMode.FIXED_BPM
    assert warp.bpm == 100.0
    assert warp.zero_sec == 0.0
    assert warp.beat_map is None


# --- piecewise-linear BeatMap mode (design 6.1) ------------------------------------


def test_piecewise_passes_exactly_through_anchors() -> None:
    """Acceptance: piecewise-linear TimeWarp passes exactly through anchors."""
    anchors = (
        _anchor(0.0, Fraction(0)),
        _anchor(0.5, Fraction(1)),
        _anchor(1.25, Fraction(3)),
        _anchor(2.0, Fraction(4)),
    )
    warp = TimeWarp.from_beat_map(BeatMap(anchors))
    for anchor in anchors:
        pos = warp.seconds_to_ql(anchor.time_sec)
        assert pos == anchor.score_pos_ql
        assert isinstance(pos, Fraction)


def test_piecewise_interpolation_midpoint() -> None:
    warp = TimeWarp.from_anchors(
        [_anchor(0.0, Fraction(0)), _anchor(1.0, Fraction(2))]
    )
    assert warp.seconds_to_ql(0.5) == Fraction(1)
    assert warp.seconds_to_ql(0.25) == Fraction(1, 2)


def test_tempo_change_mid_map() -> None:
    """Acceptance: tempo change mid-map — 120 BPM then 60 BPM."""
    warp = TimeWarp.from_anchors(
        [
            _anchor(0.0, Fraction(0)),
            _anchor(1.0, Fraction(2)),  # 2 ql/s = 120 BPM
            _anchor(3.0, Fraction(4)),  # 1 ql/s = 60 BPM
        ]
    )
    assert warp.seconds_to_ql(0.5) == Fraction(1)  # fast segment
    assert warp.seconds_to_ql(2.0) == Fraction(3)  # slow segment
    assert warp.ql_to_seconds(Fraction(1)) == 0.5
    assert warp.ql_to_seconds(Fraction(3)) == 2.0


def test_piecewise_inverse_round_trip() -> None:
    anchors = (
        _anchor(0.0, Fraction(0)),
        _anchor(0.5, Fraction(1)),
        _anchor(1.0, Fraction(2)),
        _anchor(2.0, Fraction(3)),
    )
    warp = TimeWarp.from_beat_map(BeatMap(anchors))
    for anchor in anchors:
        assert warp.ql_to_seconds(anchor.score_pos_ql) == pytest.approx(anchor.time_sec)
    # interior point round-trips exactly (all arithmetic is rational)
    q = warp.seconds_to_ql(0.7)
    assert warp.ql_to_seconds(q) == pytest.approx(0.7)


def test_extrapolation_beyond_anchors() -> None:
    """Acceptance: out-of-range inputs use the nearest segment slope."""
    warp = TimeWarp.from_anchors(
        [_anchor(0.0, Fraction(0)), _anchor(1.0, Fraction(2))]
    )
    assert warp.seconds_to_ql(2.0) == Fraction(4)  # last slope: 2 ql/s
    assert warp.seconds_to_ql(-0.5) == Fraction(-1)  # first slope
    assert warp.ql_to_seconds(Fraction(5)) == 2.5
    assert warp.ql_to_seconds(Fraction(-1)) == -0.5


def test_uneven_anchor_spacing_interpolation() -> None:
    """Rational interpolation is exact even with non-binary fractions."""
    warp = TimeWarp.from_anchors(
        [_anchor(0.0, Fraction(0)), _anchor(0.3, Fraction(1))]
    )
    # t = 0.15 s -> exactly 1/2 ql, no float drift
    assert warp.seconds_to_ql(0.15) == Fraction(1, 2)


def test_compound_meter_anchor_spacing() -> None:
    """6/8 dotted-quarter pulse: anchors advance 3/2 ql per beat (design 5.2)."""
    warp = TimeWarp.from_anchors(
        [
            _anchor(0.0, Fraction(0)),
            _anchor(0.6, Fraction(3, 2)),
            _anchor(1.2, Fraction(3)),
        ]
    )
    assert warp.seconds_to_ql(0.6) == Fraction(3, 2)
    assert warp.ql_to_seconds(Fraction(3, 2)) == pytest.approx(0.6)


def test_beat_map_mode_reported() -> None:
    beat_map = BeatMap((_anchor(0.0, Fraction(0)), _anchor(1.0, Fraction(2))))
    warp = TimeWarp.from_beat_map(beat_map)
    assert warp.mode is TimeWarpMode.BEAT_MAP
    assert warp.beat_map is beat_map
    assert warp.bpm is None


# --- BeatMap validation (acceptance: invalid/non-monotonic fails clearly) ----------


def test_beat_map_sorts_anchors() -> None:
    beat_map = BeatMap((_anchor(1.0, Fraction(2)), _anchor(0.0, Fraction(0))))
    assert [a.time_sec for a in beat_map.anchors] == [0.0, 1.0]
    assert beat_map.start_sec == 0.0
    assert beat_map.end_sec == 1.0
    assert beat_map.start_ql == Fraction(0)
    assert beat_map.end_ql == Fraction(2)
    assert len(beat_map) == 2


def test_non_monotonic_beat_map_fails() -> None:
    """score_pos_ql moving backwards = negative tempo -> clear failure."""
    with pytest.raises(InvalidBeatMapError, match="monotonic"):
        BeatMap(
            (
                _anchor(0.0, Fraction(0)),
                _anchor(1.0, Fraction(2)),
                _anchor(1.5, Fraction(1)),
            )
        )


def test_zero_tempo_segment_fails() -> None:
    """Equal ql at two distinct times is non-invertible -> clear failure."""
    with pytest.raises(InvalidBeatMapError, match="monotonic"):
        BeatMap((_anchor(0.0, Fraction(0)), _anchor(1.0, Fraction(0))))


def test_duplicate_anchor_time_fails() -> None:
    with pytest.raises(InvalidBeatMapError, match="strictly increase"):
        BeatMap((_anchor(0.5, Fraction(0)), _anchor(0.5, Fraction(1))))


def test_too_few_anchors_fail() -> None:
    with pytest.raises(InvalidBeatMapError, match="at least 2"):
        BeatMap(())
    with pytest.raises(InvalidBeatMapError, match="at least 2"):
        BeatMap((_anchor(0.0, Fraction(0)),))


def test_invalid_beat_map_error_is_value_error() -> None:
    with pytest.raises(ValueError):
        BeatMap(())


# --- exactness / input guards -----------------------------------------------------


def test_anchor_rejects_float_score_pos() -> None:
    with pytest.raises(TypeError, match="exact Fraction"):
        BeatAnchor(time_sec=0.0, score_pos_ql=0.5)  # type: ignore[arg-type]
    assert BeatAnchor(time_sec=0.0, score_pos_ql=1).score_pos_ql == Fraction(1)  # type: ignore[arg-type]


def test_anchor_rejects_non_finite_time() -> None:
    with pytest.raises(ValueError, match="finite"):
        BeatAnchor(time_sec=math.nan, score_pos_ql=Fraction(0))


def test_anchor_source_and_confidence() -> None:
    anchor = BeatAnchor(
        time_sec=0.0,
        score_pos_ql=Fraction(0),
        confidence=0.9,
        source=BeatSource.BEAT_TRACKER,
    )
    assert anchor.source is BeatSource.BEAT_TRACKER
    with pytest.raises(ValueError, match="\\[0, 1\\]"):
        BeatAnchor(time_sec=0.0, score_pos_ql=Fraction(0), confidence=1.5)


def test_seconds_to_ql_rejects_non_finite() -> None:
    warp = TimeWarp.fixed_bpm(120.0)
    with pytest.raises(ValueError, match="finite"):
        warp.seconds_to_ql(math.nan)
    with pytest.raises(ValueError, match="finite"):
        warp.seconds_to_ql(math.inf)


def test_ql_to_seconds_requires_exact_fraction() -> None:
    warp = TimeWarp.fixed_bpm(120.0)
    with pytest.raises(TypeError, match="exact Fraction"):
        warp.ql_to_seconds(0.5)  # type: ignore[arg-type]
    assert warp.ql_to_seconds(1) == 0.5  # int is exact, accepted


# --- normalize_to_score_time (design 32 step 1) -------------------------------------


def _event(onset: float, offset: float) -> RawNoteEvent:
    return RawNoteEvent(
        id=RawNoteEventId("rne-000001"),
        transcription_revision=_TR,
        pitch_midi=60.4,
        onset_sec=onset,
        offset_sec=offset,
        confidence=0.9,
    )


def test_normalize_to_score_time() -> None:
    notes = normalize_to_score_time([_event(0.5, 1.0)], TimeWarp.fixed_bpm(120.0))
    assert len(notes) == 1
    note = notes[0]
    assert note.source_id == "rne-000001"
    assert note.pitch_midi == 60  # rounded to int at normalization (design 5.4)
    assert note.onset_ql == pytest.approx(1.0)
    assert note.offset_ql == pytest.approx(2.0)
    assert note.confidence == 0.9


def test_normalize_applies_alignment_shift() -> None:
    notes = normalize_to_score_time(
        [_event(0.5, 1.0)], TimeWarp.fixed_bpm(120.0), alignment_shift_sec=0.5
    )
    assert notes[0].onset_ql == pytest.approx(2.0)


def test_normalize_rejects_non_finite_shift() -> None:
    with pytest.raises(ValueError, match="finite"):
        normalize_to_score_time([], TimeWarp.fixed_bpm(120.0), alignment_shift_sec=math.nan)
