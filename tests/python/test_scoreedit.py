"""#115 (spec 13): score-level rhythm edits — duration, onset, tie.

Each test builds a small canonical payload, applies an edit through
``apply_score_edit`` and asserts the re-realized notation: measure
tiling stays exact, rests fill the gaps, ids survive and the monophonic
contract is enforced (never silently)."""

from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

import pytest

from hornscribe.domain.ids import ProjectId, RawNoteEventId, ScoreNoteId
from hornscribe.domain.score import (
    KeySignature,
    MeterChange,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
)
from hornscribe.transcription.scoreedit import (
    ScoreEdit,
    ScoreEditError,
    apply_score_edit,
)


def _note(
    n: int, pitch: int, start: str, dur: str, **kw: object
) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId(f"sn-{n:06d}"),
        source_event_ids=(RawNoteEventId(f"rne-{n:06d}"),),
        pitch_midi=pitch,
        start_beat=Fraction(start),
        duration_beats=Fraction(dur),
        **kw,  # type: ignore[arg-type]
    )


def _doc(
    notes: list[QuantizedNote],
    rests: tuple = (),
    settings: dict | None = None,
) -> ScoreDocument:
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="part-1", name="Horn in F", notes=tuple(notes), rests=rests),),
        quantization_settings=settings or {},
    )
    return ScoreDocument(
        project_id=ProjectId("proj-test"),
        payload=payload,
        title="t",
    )


def _edit(kind: str, note: str, **kw: object) -> ScoreEdit:
    return ScoreEdit.from_dict({"kind": kind, "noteId": note, **kw})


def _total_span(part: Part) -> Fraction:
    total = Fraction(0)
    for n in part.notes:
        total += n.duration_beats
    for r in part.rests:
        total += r.duration_beats
    return total


class TestSetDuration:
    def test_shorter_leaves_rest(self) -> None:
        # Quarter -> eighth at beat 0 in 4/4: the freed half-beat becomes
        # a rest before the next note at beat 1.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(doc, _edit("setDuration", "sn-000001", durationBeats="1/2"))
        part = out.payload.parts[0]
        n1 = part.notes[0]
        assert n1.duration_beats == Fraction(1, 2)
        assert sum(a.duration_beats for a in n1.atoms) == Fraction(1, 2)
        # Measure must still tile exactly: notes + rests = 4 beats.
        assert _total_span(part) == Fraction(4)
        assert any(
            r.start_beat == Fraction(1, 2) and r.end_beat == Fraction(1)
            for r in part.rests
        )
        # The edit changed content, so the revision must change.
        assert out.revision != doc.revision

    def test_longer_recovers_gap(self) -> None:
        doc = _doc([_note(1, 60, "0", "1/2"), _note(2, 62, "1", "1")])
        out = apply_score_edit(doc, _edit("setDuration", "sn-000001", durationBeats="1"))
        part = out.payload.parts[0]
        assert part.notes[0].duration_beats == Fraction(1)
        assert _total_span(part) == Fraction(4)

    def test_longer_past_next_onset_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        with pytest.raises(ScoreEditError, match="next note"):
            apply_score_edit(
                doc, _edit("setDuration", "sn-000001", durationBeats="3/2")
            )

    def test_zero_duration_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError):
            apply_score_edit(doc, _edit("setDuration", "sn-000001", durationBeats="0"))


class TestShiftOnset:
    def test_shift_right(self) -> None:
        # sn-1 at beat 0 (quarter) shifts one 16th right into open space;
        # a 16th rest opens before it and the trailing gap grows.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "2", "1")])
        out = apply_score_edit(doc, _edit("shiftOnset", "sn-000001", steps=1))
        part = out.payload.parts[0]
        assert part.notes[0].start_beat == Fraction(1, 4)
        assert _total_span(part) == Fraction(4)
        assert any(r.start_beat == 0 and r.end_beat == Fraction(1, 4) for r in part.rests)

    def test_shift_right_into_next_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        with pytest.raises(ScoreEditError, match="next note"):
            apply_score_edit(doc, _edit("shiftOnset", "sn-000001", steps=4))

    def test_shift_left_clips_previous(self) -> None:
        # The previous note's tail is clipped at the moved onset — the
        # monophonic contract, applied honestly.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(doc, _edit("shiftOnset", "sn-000002", steps=-2))
        part = out.payload.parts[0]
        assert part.notes[0].duration_beats == Fraction(1, 2)
        assert part.notes[1].start_beat == Fraction(1, 2)
        assert _total_span(part) == Fraction(4)

    def test_shift_before_zero_rejected(self) -> None:
        doc = _doc([_note(1, 60, "1", "1")])
        with pytest.raises(ScoreEditError, match="before the score"):
            apply_score_edit(doc, _edit("shiftOnset", "sn-000001", steps=-8))


class TestToggleTie:
    def test_tie_and_untie(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 60, "1", "1")])
        out = apply_score_edit(doc, _edit("toggleTie", "sn-000001"))
        assert out.payload.parts[0].notes[0].tie_start is True
        assert out.payload.parts[0].notes[1].tie_stop is True
        back = apply_score_edit(out, _edit("toggleTie", "sn-000001"))
        assert back.payload.parts[0].notes[0].tie_start is False
        assert back.payload.parts[0].notes[1].tie_stop is False

    def test_different_pitch_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        with pytest.raises(ScoreEditError, match="same pitch"):
            apply_score_edit(doc, _edit("toggleTie", "sn-000001"))

    def test_non_contiguous_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1/2"), _note(2, 60, "1", "1")])
        with pytest.raises(ScoreEditError, match="contiguous"):
            apply_score_edit(doc, _edit("toggleTie", "sn-000001"))

    def test_last_note_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="no next note"):
            apply_score_edit(doc, _edit("toggleTie", "sn-000001"))


class TestSetTempo:
    def test_replaces_head_segment(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(doc, _edit("setTempo", "", bpm=96.0))
        assert out.payload.tempo_map == (
            TempoSegment(start_beat=Fraction(0), bpm=96.0),
        )
        assert out.revision != doc.revision

    def test_keeps_later_segments(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        later = TempoSegment(start_beat=Fraction(8), bpm=60.0)
        doc = replace(
            doc,
            payload=replace(
                doc.payload, tempo_map=doc.payload.tempo_map + (later,)
            ),
        )
        out = apply_score_edit(doc, _edit("setTempo", "", bpm=100.0))
        assert out.payload.tempo_map == (
            TempoSegment(start_beat=Fraction(0), bpm=100.0),
            later,
        )

    def test_prepends_when_map_starts_later(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        later = TempoSegment(start_beat=Fraction(4), bpm=80.0)
        doc = replace(
            doc, payload=replace(doc.payload, tempo_map=(later,))
        )
        out = apply_score_edit(doc, _edit("setTempo", "", bpm=72.0))
        assert out.payload.tempo_map == (
            TempoSegment(start_beat=Fraction(0), bpm=72.0),
            later,
        )

    def test_empty_map_prepends(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc, payload=replace(doc.payload, tempo_map=())
        )
        out = apply_score_edit(doc, _edit("setTempo", "", bpm=88.0))
        assert out.payload.tempo_map == (
            TempoSegment(start_beat=Fraction(0), bpm=88.0),
        )

    def test_missing_bpm_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="bpm"):
            ScoreEdit.from_dict({"kind": "setTempo", "noteId": ""})

    def test_out_of_range_rejected(self) -> None:
        for bad in (10.0, 401.0):
            with pytest.raises(ScoreEditError, match="range"):
                ScoreEdit.from_dict(
                    {"kind": "setTempo", "noteId": "", "bpm": bad}
                )

    def test_non_numeric_bpm_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="number"):
            ScoreEdit.from_dict(
                {"kind": "setTempo", "noteId": "", "bpm": "fast"}
            )

    def test_notes_untouched(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(doc, _edit("setTempo", "", bpm=140.0))
        assert out.payload.parts[0].notes == doc.payload.parts[0].notes


class TestSetMeter:
    def test_same_unit_retiles(self) -> None:
        # 4/4 -> 3/4: positions unchanged, atoms re-decomposed to the
        # new barlines, a quarter at beat 3 now sits across a barline.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "3", "1")])
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=3, beatUnit=4)
        )
        assert out.payload.time_signature == TimeSignature(
            beats_per_measure=3, beat_unit=4
        )
        notes = out.payload.parts[0].notes
        assert notes[0].start_beat == Fraction(0)
        assert notes[1].start_beat == Fraction(3)
        assert notes[1].duration_beats == Fraction(1)
        assert out.revision != doc.revision

    def test_unit_change_rescales_positions(self) -> None:
        # 4/4 -> 6/8: beat axis doubles (eighth-note beats), absolute
        # durations preserved — a quarter becomes 2 eighth-beats.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=6, beatUnit=8)
        )
        notes = out.payload.parts[0].notes
        assert notes[0].start_beat == Fraction(0)
        assert notes[0].duration_beats == Fraction(2)
        assert notes[1].start_beat == Fraction(2)
        assert notes[1].duration_beats == Fraction(2)

    def test_tempo_map_and_pickup_rescale(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                pickup_beats=Fraction(1),
                tempo_map=(
                    TempoSegment(start_beat=Fraction(0), bpm=120.0),
                    TempoSegment(start_beat=Fraction(4), bpm=90.0),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=6, beatUnit=8)
        )
        assert out.payload.pickup_beats == Fraction(2)
        assert out.payload.tempo_map[1].start_beat == Fraction(8)
        assert out.payload.tempo_map[1].bpm == 90.0

    def test_meter_changes_collapsed(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        change = MeterChange(
            start_beat=Fraction(0),
            time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
            measure_phase_beats=Fraction(0),
        )
        doc = replace(
            doc,
            payload=replace(doc.payload, meter_changes=(change,)),
        )
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=3, beatUnit=4)
        )
        assert out.payload.meter_changes == ()
        assert out.payload.time_signature.beats_per_measure == 3

    def test_rests_retiled(self) -> None:
        # Note at beat 0, rest tiling beats 1-4 in 4/4; under 3/4 the
        # rest must re-decompose across the new barlines.
        doc = _doc([_note(1, 60, "0", "1")])
        part = doc.payload.parts[0]
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                parts=(
                    replace(
                        part,
                        rests=(
                            ScoreRest(
                                start_beat=Fraction(1),
                                atoms=(
                                    ScoreAtom(
                                        duration_beats=Fraction(3),
                                        symbol="half",
                                        dots=1,
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=3, beatUnit=4)
        )
        rests = out.payload.parts[0].rests
        assert rests, "rest span must survive the re-tile"
        total = sum((r.duration_beats for r in rests), Fraction(0))
        assert total == Fraction(3)

    def test_missing_fields_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="requires"):
            ScoreEdit.from_dict({"kind": "setMeter", "noteId": ""})
        with pytest.raises(ScoreEditError, match="requires"):
            ScoreEdit.from_dict(
                {"kind": "setMeter", "noteId": "", "beatsPerMeasure": 3}
            )

    def test_invalid_meter_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="beatUnit"):
            ScoreEdit.from_dict(
                {
                    "kind": "setMeter",
                    "noteId": "",
                    "beatsPerMeasure": 4,
                    "beatUnit": 3,
                }
            )
        with pytest.raises(ScoreEditError, match="beatsPerMeasure"):
            ScoreEdit.from_dict(
                {
                    "kind": "setMeter",
                    "noteId": "",
                    "beatsPerMeasure": 0,
                    "beatUnit": 4,
                }
            )


class TestEditParsing:
    def test_unknown_kind_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="kind"):
            ScoreEdit.from_dict({"kind": "smear", "noteId": "sn-000001"})

    def test_missing_note_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="not found"):
            apply_score_edit(doc, _edit("toggleTie", "sn-999999"))
