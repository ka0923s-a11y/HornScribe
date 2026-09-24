"""Backend note-tuple -> RawNoteEvent mapping tests (#169).

predict_note_events needs the real ONNX model, so the tuple mapping
lives in pure helpers (_to_raw_event / _bend_points) that unit tests
exercise without basic_pitch installed.
"""

from __future__ import annotations

from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.transcription.backend import _bend_points, _to_raw_event


def _rev() -> TranscriptionRevisionId:
    return TranscriptionRevisionId("tr-000001")


class TestBendPoints:
    def test_center_is_zero_semitones(self):
        pts = _bend_points([8192, 8192], 1.0, 2.0)
        assert [p.bend_semitones for p in pts] == [0.0, 0.0]

    def test_full_range_maps_to_plus_minus_two(self):
        pts = _bend_points([0, 8192, 16383], 0.0, 1.0)
        assert pts[0].bend_semitones == -2.0
        assert pts[2].bend_semitones == (16383 - 8192) / 4096.0

    def test_times_span_the_note(self):
        pts = _bend_points([8192, 8192, 8192, 8192, 8192], 2.0, 3.0)
        assert pts[0].time_sec == 2.0
        assert pts[-1].time_sec == 3.0
        assert pts[2].time_sec == 2.5

    def test_empty_and_malformed_input(self):
        assert _bend_points([], 0.0, 1.0) == ()
        assert _bend_points(None, 0.0, 1.0) == ()
        assert _bend_points(["x", "y"], 0.0, 1.0) == ()


class TestToRawEvent:
    def test_bends_are_kept(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60, 0.8, [8192, 12288]),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert len(ev.pitch_bends) == 2
        assert ev.pitch_bends[1].bend_semitones == 1.0
        assert ev.pitch_bends[0].time_sec == 0.5
        assert ev.pitch_bends[1].time_sec == 1.5

    def test_missing_bends_yields_empty(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60, 0.8),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert ev.pitch_bends == ()

    def test_scalar_fields(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60.0, 0.8, []),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert ev.pitch_midi == 60.0
        assert ev.confidence == 0.8
        assert ev.velocity == 88
        assert ev.source == "basic_pitch"

