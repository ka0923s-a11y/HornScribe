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
    KeyChange,
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


class TestSplitMerge:
    def test_split_midpoint(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(doc, _edit("splitNote", "sn-000001"))
        notes = out.payload.parts[0].notes
        assert len(notes) == 3
        assert notes[0].id == ScoreNoteId("sn-000001")
        assert notes[0].duration_beats == Fraction(1, 2)
        assert notes[1].start_beat == Fraction(1, 2)
        assert notes[1].duration_beats == Fraction(1, 2)
        assert str(notes[1].id).startswith("sn-")
        assert notes[1].id != notes[0].id
        assert notes[2].id == ScoreNoteId("sn-000002")

    def test_split_too_short_rejected(self) -> None:
        # A single grid-step note has no interior grid point.
        doc = _doc([_note(1, 60, "0", "1/4")])
        with pytest.raises(ScoreEditError, match="too short"):
            apply_score_edit(doc, _edit("splitNote", "sn-000001"))

    def test_split_not_tied_to_itself(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "1", tie_start=True),
                _note(2, 60, "1", "1", tie_stop=True),
            ]
        )
        out = apply_score_edit(doc, _edit("splitNote", "sn-000001"))
        notes = out.payload.parts[0].notes
        assert notes[0].tie_start is False
        assert notes[1].tie_start is True  # outgoing tie survives
        assert notes[1].tie_stop is False

    def test_merge_contiguous_same_pitch(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "1"),
                _note(2, 60, "1", "1"),
                _note(3, 62, "2", "1"),
            ]
        )
        out = apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))
        notes = out.payload.parts[0].notes
        assert len(notes) == 2
        assert notes[0].id == ScoreNoteId("sn-000001")
        assert notes[0].duration_beats == Fraction(2)
        assert notes[0].source_event_ids == (
            RawNoteEventId("rne-000001"),
            RawNoteEventId("rne-000002"),
        )
        assert notes[1].id == ScoreNoteId("sn-000003")

    def test_merge_different_pitch_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        with pytest.raises(ScoreEditError, match="same pitch"):
            apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))

    def test_merge_non_contiguous_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1/2"), _note(2, 60, "1", "1")])
        with pytest.raises(ScoreEditError, match="contiguous"):
            apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))

    def test_merge_last_note_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="no next note"):
            apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))

    def test_split_merge_roundtrip(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        split = apply_score_edit(doc, _edit("splitNote", "sn-000001"))
        merged = apply_score_edit(split, _edit("mergeNotes", "sn-000001"))
        notes = merged.payload.parts[0].notes
        assert len(notes) == 2
        assert notes[0].duration_beats == Fraction(1)


class TestLayerAwareMergeTie:
    """#260: merge/tie resolve the partner by notation layer + temporal
    adjacency — a chord mate in storage order is never the partner."""

    @staticmethod
    def _chord_doc() -> ScoreDocument:
        # Two C+E chords a beat apart; storage order interleaves the
        # members so notes[i+1] is the chord mate, not the next onset.
        return _doc(
            [
                _note(1, 60, "0", "1"),  # C4 chord 1
                _note(2, 64, "0", "1"),  # E4 chord 1
                _note(3, 60, "1", "1"),  # C4 chord 2
                _note(4, 64, "1", "1"),  # E4 chord 2
            ]
        )

    def test_tie_inside_chord_picks_same_pitch_next_onset(self) -> None:
        doc = self._chord_doc()
        out = apply_score_edit(doc, _edit("toggleTie", "sn-000001"))
        notes = {n.id: n for n in out.payload.parts[0].notes}
        assert notes[ScoreNoteId("sn-000001")].tie_start is True
        assert notes[ScoreNoteId("sn-000003")].tie_stop is True
        # The chord mate is untouched.
        assert notes[ScoreNoteId("sn-000002")].tie_stop is False
        assert notes[ScoreNoteId("sn-000002")].tie_start is False

    def test_tie_upper_chord_member(self) -> None:
        doc = self._chord_doc()
        out = apply_score_edit(doc, _edit("toggleTie", "sn-000002"))
        notes = {n.id: n for n in out.payload.parts[0].notes}
        assert notes[ScoreNoteId("sn-000002")].tie_start is True
        assert notes[ScoreNoteId("sn-000004")].tie_stop is True

    def test_merge_inside_chord_picks_same_pitch_next_onset(self) -> None:
        doc = self._chord_doc()
        out = apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))
        notes = out.payload.parts[0].notes
        ids = [n.id for n in notes]
        assert ScoreNoteId("sn-000003") not in ids
        merged = next(n for n in notes if n.id == ScoreNoteId("sn-000001"))
        assert merged.duration_beats == Fraction(2)
        assert merged.source_event_ids == (
            RawNoteEventId("rne-000001"),
            RawNoteEventId("rne-000003"),
        )
        # The E4 chord members survive untouched.
        assert ScoreNoteId("sn-000002") in ids
        assert ScoreNoteId("sn-000004") in ids

    def test_merge_never_skips_intervening_onset(self) -> None:
        """A different-pitch note at the next onset blocks the merge —
        we never jump ahead to a later same-pitch note."""
        doc = _doc(
            [
                _note(1, 60, "0", "1"),
                _note(2, 62, "1", "1"),  # next onset, different pitch
                _note(3, 60, "2", "1"),  # same pitch but NOT next onset
            ]
        )
        with pytest.raises(ScoreEditError, match="same pitch"):
            apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))

    def test_merge_non_contiguous_next_onset_rejected(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "1"),
                _note(2, 64, "0", "1"),  # chord mate
                _note(3, 60, "3", "1"),  # same pitch, not contiguous
            ]
        )
        with pytest.raises(ScoreEditError, match="contiguous"):
            apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))

    def test_tie_secondary_voice_partner(self) -> None:
        """An overlapping (non-chord) note gets its own layer; the
        partner lookup stays inside the selected note's layer."""
        doc = _doc(
            [
                _note(1, 60, "0", "2"),  # half note, layer 0
                _note(2, 64, "0", "1"),  # quarter, layer 1
                _note(3, 60, "2", "1"),  # layer 0 again
                _note(4, 64, "1", "1"),  # layer 1
            ]
        )
        out = apply_score_edit(doc, _edit("toggleTie", "sn-000001"))
        notes = {n.id: n for n in out.payload.parts[0].notes}
        assert notes[ScoreNoteId("sn-000001")].tie_start is True
        assert notes[ScoreNoteId("sn-000003")].tie_stop is True
        # Layer 1 (the 64s) is untouched.
        assert notes[ScoreNoteId("sn-000002")].tie_start is False
        assert notes[ScoreNoteId("sn-000004")].tie_stop is False

    def test_merge_secondary_voice_partner(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "2"),
                _note(2, 64, "0", "1"),
                _note(3, 60, "2", "1"),
                _note(4, 64, "1", "1"),
            ]
        )
        out = apply_score_edit(doc, _edit("mergeNotes", "sn-000001"))
        notes = out.payload.parts[0].notes
        ids = [n.id for n in notes]
        assert ScoreNoteId("sn-000003") not in ids
        merged = next(n for n in notes if n.id == ScoreNoteId("sn-000001"))
        assert merged.duration_beats == Fraction(3)

class TestRequantize:
    def test_ids_preserved_positionally(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        out = apply_score_edit(
            doc,
            _edit("requantize", "", settings={"minDurationQl": "1/2"}),
        )
        ids = [str(n.id) for n in out.payload.parts[0].notes]
        assert ids == ["sn-000001", "sn-000002"]
        assert out.payload.quantization_settings["minDurationQl"] == "1/2"
        assert out.revision != doc.revision

    def test_settings_merge_keeps_untouched_keys(self) -> None:
        doc = _doc(
            [_note(1, 60, "0", "1")],
            settings={"simplicity": "standard", "triplets": "auto"},
        )
        out = apply_score_edit(
            doc, _edit("requantize", "", settings={"triplets": "none"})
        )
        qs = out.payload.quantization_settings
        assert qs["triplets"] == "none"
        assert qs["simplicity"] == "standard"

    def test_triplets_none_rewrites_atoms(self) -> None:
        # Sixteenth-grid onsets re-quantized with triplets disabled can
        # no longer use triplet atoms — the written decomposition must
        # be binary.
        doc = _doc(
            [
                _note(1, 60, "0", "1/4"),
                _note(2, 62, "1/4", "1/4"),
                _note(3, 64, "1/2", "1/2"),
            ],
            settings={"triplets": "auto"},
        )
        out = apply_score_edit(
            doc,
            _edit(
                "requantize",
                "",
                settings={"triplets": "none", "minDurationQl": "1/4"},
            ),
        )
        for n in out.payload.parts[0].notes:
            for atom in n.atoms:
                assert atom.tuplet is None

    def test_source_ids_carried_over(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(
            doc,
            _edit("requantize", "", settings={"minDurationQl": "1/2"}),
        )
        assert out.payload.parts[0].notes[0].source_event_ids == (
            RawNoteEventId("rne-000001"),
        )

    def test_empty_settings_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="settings"):
            ScoreEdit.from_dict({"kind": "requantize", "noteId": ""})
        with pytest.raises(ScoreEditError, match="at least one"):
            ScoreEdit.from_dict(
                {"kind": "requantize", "noteId": "", "settings": {}}
            )

    def test_unknown_setting_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="unknown"):
            ScoreEdit.from_dict(
                {
                    "kind": "requantize",
                    "noteId": "",
                    "settings": {"bpm": 120},
                }
            )

    def test_invalid_values_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="triplets"):
            ScoreEdit.from_dict(
                {
                    "kind": "requantize",
                    "noteId": "",
                    "settings": {"triplets": "lots"},
                }
            )
        with pytest.raises(ScoreEditError, match="minDurationQl"):
            ScoreEdit.from_dict(
                {
                    "kind": "requantize",
                    "noteId": "",
                    "settings": {"minDurationQl": "tiny"},
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


class TestSetKey:
    """#145: key edits — setKey / keyChangeAt / removeKeyChange."""

    def test_set_key_replaces_head_signature(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(
            doc, _edit("setKey", "", fifths=-2, mode="major")
        )
        assert out.payload.key_signature == KeySignature(-2, "major")
        assert out.payload.key_changes == ()
        assert out.revision != doc.revision

    def test_set_key_collapses_existing_changes(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                key_changes=(
                    KeyChange(Fraction(0), KeySignature(0, "major")),
                    KeyChange(Fraction(8), KeySignature(-5, "major")),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("setKey", "", fifths=1, mode="major")
        )
        assert out.payload.key_signature.fifths == 1
        assert out.payload.key_changes == (
            KeyChange(Fraction(0), KeySignature(1, "major")),
        )

    def test_key_change_at_inserts_boundary(self) -> None:
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 62, "8", "1")]
        )
        out = apply_score_edit(
            doc,
            _edit("keyChangeAt", "", fifths=-5, startBeat="8/1"),
        )
        assert len(out.payload.key_changes) == 2
        assert out.payload.key_changes[1].start_beat == Fraction(8)
        assert out.payload.key_changes[1].key_signature.fifths == -5
        # Head change carries the payload key (validation contract).
        assert out.payload.key_changes[0].start_beat == 0
        assert out.payload.key_changes[0].key_signature.fifths == 0

    def test_key_change_at_snaps_to_measure_start(self) -> None:
        # Beat 10 sits inside the measure starting at 8 (4/4) — the
        # boundary lands on the barline, not mid-measure.
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 62, "10", "1")]
        )
        out = apply_score_edit(
            doc,
            _edit("keyChangeAt", "", fifths=2, startBeat="10/1"),
        )
        assert out.payload.key_changes[-1].start_beat == Fraction(8)

    def test_key_change_at_beat_zero_updates_head(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(
            doc,
            _edit("keyChangeAt", "", fifths=3, startBeat="0/1"),
        )
        assert out.payload.key_signature.fifths == 3
        # Single key — collapsed to the no-map path.
        assert out.payload.key_changes == ()

    def test_remove_key_change(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                key_changes=(
                    KeyChange(Fraction(0), KeySignature(0, "major")),
                    KeyChange(Fraction(8), KeySignature(-5, "major")),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("removeKeyChange", "", startBeat="8/1")
        )
        assert out.payload.key_changes == ()
        assert out.payload.key_signature.fifths == 0

    def test_remove_head_change_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                key_changes=(
                    KeyChange(Fraction(0), KeySignature(0, "major")),
                    KeyChange(Fraction(8), KeySignature(-5, "major")),
                ),
            ),
        )
        with pytest.raises(ScoreEditError, match="head key"):
            apply_score_edit(
                doc, _edit("removeKeyChange", "", startBeat="0/1")
            )

    def test_key_edits_validated(self) -> None:
        with pytest.raises(ScoreEditError, match="fifths"):
            _edit("setKey", "")
        with pytest.raises(ScoreEditError, match="-7"):
            _edit("setKey", "", fifths=9)
        with pytest.raises(ScoreEditError, match="startBeat"):
            _edit("keyChangeAt", "", fifths=0)
        with pytest.raises(ScoreEditError, match="mode"):
            _edit("setKey", "", fifths=0, mode="dorian")

    def test_key_change_at_by_measure(self) -> None:
        # #145: the UI names measures, not beats — measure 3 of a
        # 4/4 score starts at beat 8.
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 62, "8", "1")]
        )
        out = apply_score_edit(
            doc,
            _edit("keyChangeAt", "", fifths=-5, startMeasure=3),
        )
        assert out.payload.key_changes[-1].start_beat == Fraction(8)
        assert out.payload.key_changes[-1].key_signature.fifths == -5

    def test_remove_key_change_by_measure(self) -> None:
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 62, "8", "1")]
        )
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                key_changes=(
                    KeyChange(Fraction(0), KeySignature(0, "major")),
                    KeyChange(Fraction(8), KeySignature(-5, "major")),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("removeKeyChange", "", startMeasure=3)
        )
        assert out.payload.key_changes == ()
        assert out.payload.key_signature.fifths == 0

    def test_start_measure_out_of_range_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="no measure"):
            apply_score_edit(
                doc, _edit("keyChangeAt", "", fifths=0, startMeasure=99)
            )

    def test_start_beat_and_measure_conflict_rejected(self) -> None:
        with pytest.raises(ScoreEditError, match="not both"):
            _edit(
                "keyChangeAt", "", fifths=0,
                startBeat="8/1", startMeasure=3,
            )

    def test_start_measure_validated(self) -> None:
        with pytest.raises(ScoreEditError, match="startMeasure"):
            _edit("keyChangeAt", "", fifths=0, startMeasure=-1)
        with pytest.raises(ScoreEditError, match="startMeasure"):
            _edit("keyChangeAt", "", fifths=0, startMeasure="3")


class TestSetMetadata:
    """#271: notation metadata edits — title/composer/arranger."""

    def test_sets_all_fields(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(
            doc,
            _edit(
                "setMetadata", "",
                metadata={
                    "title": "New Title",
                    "composer": "Composer X",
                    "arranger": "Arranger Y",
                },
            ),
        )
        assert out.title == "New Title"
        assert out.composer == "Composer X"
        assert out.arranger == "Arranger Y"

    def test_partial_update_keeps_others(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(doc, composer="C", arranger="A")
        out = apply_score_edit(
            doc,
            _edit("setMetadata", "", metadata={"title": "T2"}),
        )
        assert out.title == "T2"
        assert out.composer == "C"
        assert out.arranger == "A"

    def test_empty_string_clears(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(doc, composer="C")
        out = apply_score_edit(
            doc,
            _edit("setMetadata", "", metadata={"composer": ""}),
        )
        assert out.composer is None

    def test_revision_unchanged(self) -> None:
        # #271: metadata lives outside the payload — the content-
        # derived score revision must not churn on a title edit.
        doc = _doc([_note(1, 60, "0", "1")])
        out = apply_score_edit(
            doc, _edit("setMetadata", "", metadata={"title": "T"}),
        )
        assert out.revision == doc.revision

    def test_round_trip_through_dict(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(doc, composer="C", arranger="A", title="T")
        again = type(doc).from_dict(doc.to_dict())
        assert again.composer == "C"
        assert again.arranger == "A"
        assert again.title == "T"

    def test_metadata_validated(self) -> None:
        with pytest.raises(ScoreEditError, match="metadata"):
            _edit("setMetadata", "")
        with pytest.raises(ScoreEditError, match="metadata"):
            _edit("setMetadata", "", metadata={})
        with pytest.raises(ScoreEditError, match="unknown"):
            _edit("setMetadata", "", metadata={"publisher": "x"})
        with pytest.raises(ScoreEditError, match="composer"):
            _edit("setMetadata", "", metadata={"composer": 3})


class TestTranspose:
    """#267/#261: canonical octave/semitone transposes."""

    def test_transpose_note_octave_down(self) -> None:
        doc = _doc(
            [_note(1, 96, "0", "1"), _note(2, 62, "1", "1")]
        )
        out = apply_score_edit(
            doc, _edit("transposeNote", "sn-000001", semitones=-12)
        )
        notes = out.payload.parts[0].notes
        assert notes[0].pitch_midi == 84
        assert notes[1].pitch_midi == 62
        assert out.revision != doc.revision

    def test_transpose_note_out_of_range_rejected(self) -> None:
        doc = _doc([_note(1, 120, "0", "1")])
        with pytest.raises(ScoreEditError, match="0-127"):
            apply_score_edit(
                doc, _edit("transposeNote", "sn-000001", semitones=12)
            )

    def test_transpose_range_whole_score(self) -> None:
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 64, "1", "1")]
        )
        out = apply_score_edit(
            doc, _edit("transposeRange", "", semitones=-12)
        )
        assert [n.pitch_midi for n in out.payload.parts[0].notes] == [
            48,
            52,
        ]

    def test_transpose_range_bounded(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "1"),
                _note(2, 64, "4", "1"),
                _note(3, 67, "8", "1"),
            ]
        )
        out = apply_score_edit(
            doc,
            _edit(
                "transposeRange", "",
                semitones=12, startBeat="4/1", endBeat="8/1",
            ),
        )
        assert [n.pitch_midi for n in out.payload.parts[0].notes] == [
            60,
            76,
            67,
        ]

    def test_transpose_range_atomic_rejection(self) -> None:
        # One out-of-range target rejects the whole batch — no
        # partial octave shift.
        doc = _doc(
            [_note(1, 60, "0", "1"), _note(2, 120, "1", "1")]
        )
        with pytest.raises(ScoreEditError, match="0-127"):
            apply_score_edit(
                doc, _edit("transposeRange", "", semitones=12)
            )

    def test_transpose_range_empty_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="no notes"):
            apply_score_edit(
                doc,
                _edit(
                    "transposeRange", "",
                    semitones=12, startBeat="40/1",
                ),
            )

    def test_transpose_range_bad_bounds_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="endBeat"):
            apply_score_edit(
                doc,
                _edit(
                    "transposeRange", "",
                    semitones=12, startBeat="4/1", endBeat="4/1",
                ),
            )

    def test_transpose_validated(self) -> None:
        with pytest.raises(ScoreEditError, match="semitones"):
            _edit("transposeRange", "")
        with pytest.raises(ScoreEditError, match="semitones"):
            _edit("transposeRange", "", semitones=0)
        with pytest.raises(ScoreEditError, match="semitones"):
            _edit("transposeRange", "", semitones=100)
        with pytest.raises(ScoreEditError, match="semitones"):
            _edit("transposeRange", "", semitones=1.5)


class TestKeyChanges:
    """#133: the key map on ScoreRevisionPayload."""

    def _keyed_doc(self, notes: list[QuantizedNote]) -> ScoreDocument:
        doc = _doc(notes)
        changes = (
            KeyChange(
                start_beat=Fraction(0),
                key_signature=KeySignature(fifths=0, mode="major"),
            ),
            KeyChange(
                start_beat=Fraction(8),
                key_signature=KeySignature(fifths=-5, mode="major"),
            ),
        )
        return replace(
            doc, payload=replace(doc.payload, key_changes=changes)
        )

    def test_round_trip_serialization(self) -> None:
        doc = self._keyed_doc([_note(1, 60, "0", "1")])
        data = doc.payload.to_dict()
        assert len(data["keyChanges"]) == 2
        assert data["keyChanges"][1]["startBeat"] == "8/1"
        loaded = ScoreRevisionPayload.from_dict(data)
        assert loaded.key_changes == doc.payload.key_changes

    def test_omitted_when_empty(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        assert "keyChanges" not in doc.payload.to_dict()

    def test_first_change_must_be_at_zero(self) -> None:
        with pytest.raises(ValueError, match="beat 0"):
            ScoreRevisionPayload(
                tempo_map=(TempoSegment(Fraction(0), 120.0),),
                time_signature=TimeSignature(4, 4),
                key_signature=KeySignature(0, "major"),
                pickup_beats=Fraction(0),
                parts=(),
                quantization_settings={},
                key_changes=(
                    KeyChange(
                        Fraction(4), KeySignature(0, "major")
                    ),
                ),
            )

    def test_first_change_must_match_payload_key(self) -> None:
        with pytest.raises(ValueError, match="key_signature"):
            ScoreRevisionPayload(
                tempo_map=(TempoSegment(Fraction(0), 120.0),),
                time_signature=TimeSignature(4, 4),
                key_signature=KeySignature(0, "major"),
                pickup_beats=Fraction(0),
                parts=(),
                quantization_settings={},
                key_changes=(
                    KeyChange(
                        Fraction(0), KeySignature(1, "major")
                    ),
                ),
            )

    def test_set_meter_rescales_key_change_positions(self) -> None:
        # 4/4 -> 6/8 doubles the beat axis: a modulation at beat 8
        # lands at eighth-beat 16, glued to the same absolute position.
        doc = self._keyed_doc(
            [_note(1, 60, "0", "1"), _note(2, 62, "8", "1")]
        )
        out = apply_score_edit(
            doc, _edit("setMeter", "", beatsPerMeasure=6, beatUnit=8)
        )
        assert len(out.payload.key_changes) == 2
        assert out.payload.key_changes[0].start_beat == 0
        assert out.payload.key_changes[1].start_beat == Fraction(16)
        assert out.payload.key_changes[1].key_signature.fifths == -5


class TestRestToNote:
    """#163: restToNote converts (part of) a rest span into a new note.
    Positions never shift — leftovers re-tile as rests."""

    def _rest_doc(self) -> ScoreDocument:
        # One quarter note + a three-beat rest span in 4/4.
        return _doc(
            [_note(1, 60, "0", "1")],
            rests=(
                ScoreRest(
                    start_beat=Fraction(1),
                    atoms=(ScoreAtom(Fraction(3), "half", dots=1),),
                ),
            ),
        )

    def test_convert_rest_span(self) -> None:
        doc = self._rest_doc()
        out = apply_score_edit(
            doc,
            ScoreEdit.from_dict(
                {
                    "kind": "restToNote",
                    "partId": "part-1",
                    "startBeat": "1/1",
                    "pitchMidi": 64,
                }
            ),
        )
        part = out.payload.parts[0]
        assert len(part.notes) == 2
        new = part.notes[1]
        assert new.pitch_midi == 64
        assert new.start_beat == 1
        # Default duration = the remainder of the rest span.
        assert new.duration_beats == 3
        assert new.id not in (n.id for n in doc.payload.parts[0].notes)
        assert new.source_event_ids == ()
        # Atoms re-realized and the measure still tiles exactly.
        assert sum(a.duration_beats for a in new.atoms) == 3
        assert _total_span(part) == Fraction(4)
        assert out.revision != doc.revision

    def test_partial_rest_leaves_leftovers(self) -> None:
        doc = self._rest_doc()
        out = apply_score_edit(
            doc,
            ScoreEdit.from_dict(
                {
                    "kind": "restToNote",
                    "partId": "part-1",
                    "startBeat": "2/1",
                    "durationBeats": "1/1",
                    "pitchMidi": 67,
                }
            ),
        )
        part = out.payload.parts[0]
        new = part.notes[1]
        assert new.start_beat == 2 and new.duration_beats == 1
        # A one-beat rest opens before the note, another follows.
        assert any(
            r.start_beat == 1 and r.end_beat == 2 for r in part.rests
        )
        assert any(
            r.start_beat == 3 and r.end_beat == 4 for r in part.rests
        )
        assert _total_span(part) == Fraction(4)

    def test_no_rest_at_beat_rejected(self) -> None:
        doc = self._rest_doc()
        with pytest.raises(ScoreEditError, match="no rest"):
            apply_score_edit(
                doc,
                ScoreEdit.from_dict(
                    {
                        "kind": "restToNote",
                        "partId": "part-1",
                        "startBeat": "0/1",
                        "pitchMidi": 64,
                    }
                ),
            )

    def test_unknown_part_rejected(self) -> None:
        doc = self._rest_doc()
        with pytest.raises(ScoreEditError, match="part"):
            apply_score_edit(
                doc,
                ScoreEdit.from_dict(
                    {
                        "kind": "restToNote",
                        "partId": "part-9",
                        "startBeat": "1/1",
                        "pitchMidi": 64,
                    }
                ),
            )

    def test_duration_must_fit_the_span(self) -> None:
        doc = self._rest_doc()
        with pytest.raises(ScoreEditError, match="rest span"):
            apply_score_edit(
                doc,
                ScoreEdit.from_dict(
                    {
                        "kind": "restToNote",
                        "partId": "part-1",
                        "startBeat": "3/1",
                        "durationBeats": "2/1",
                        "pitchMidi": 64,
                    }
                ),
            )

    def test_missing_fields_rejected(self) -> None:
        for raw in (
            {"kind": "restToNote", "startBeat": "1/1", "pitchMidi": 64},
            {"kind": "restToNote", "partId": "part-1", "pitchMidi": 64},
            {"kind": "restToNote", "partId": "part-1", "startBeat": "1/1"},
            {
                "kind": "restToNote",
                "partId": "part-1",
                "startBeat": "1/1",
                "pitchMidi": 200,
            },

        ):
            with pytest.raises(ScoreEditError):
                ScoreEdit.from_dict(raw)


class TestScaleTempo:
    """#198: tempo-octave correction — BPM and note values scale together.

    The defining invariant is seconds-invariance: onset_sec =
    start_beat * 60 / bpm must not move when the tempo map and the beat
    axis scale by the same factor.
    """

    def _seconds(self, doc: ScoreDocument) -> list[float]:
        bpm = doc.payload.tempo_map[0].bpm
        return [
            float(n.start_beat) * 60.0 / bpm
            for n in doc.payload.parts[0].notes
        ]

    def test_halve_rescales_notes_and_bpm(self) -> None:
        # Tracked double tempo (240 for a real 120): notes are written
        # twice too long. factor=1/2 halves BPM AND values; seconds stay.
        doc = _doc([_note(1, 60, "0", "2"), _note(2, 62, "2", "2")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=240.0),),
            ),
        )
        before = self._seconds(doc)
        out = apply_score_edit(
            doc, _edit("scaleTempo", "", factor="1/2")
        )
        part = out.payload.parts[0]
        assert out.payload.tempo_map[0].bpm == pytest.approx(120.0)
        assert [n.duration_beats for n in part.notes] == [
            Fraction(1),
            Fraction(1),
        ]
        assert [n.start_beat for n in part.notes] == [
            Fraction(0),
            Fraction(1),
        ]
        assert self._seconds(out) == pytest.approx(before)
        # Atoms re-tiled: each note's written symbols cover its span.
        for n in part.notes:
            assert n.atoms
            assert sum(a.duration_beats for a in n.atoms) == n.duration_beats
        assert out.revision != doc.revision

    def test_double_rescales_notes_and_bpm(self) -> None:
        # Tracked half tempo (60 for a real 120): eighth-note melody
        # written as quarters. factor=2 doubles BPM AND values.
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=60.0),),
            ),
        )
        before = self._seconds(doc)
        out = apply_score_edit(doc, _edit("scaleTempo", "", factor=2))
        part = out.payload.parts[0]
        assert out.payload.tempo_map[0].bpm == pytest.approx(120.0)
        assert [n.duration_beats for n in part.notes] == [
            Fraction(2),
            Fraction(2),
        ]
        assert self._seconds(out) == pytest.approx(before)

    def test_pickup_rescales(self) -> None:
        # One-beat pickup under a doubled grid: the anacrusis halves to
        # a half beat and stays an anacrusis (phase wraps, not clamps).
        doc = _doc([_note(1, 60, "0", "1/2"), _note(2, 62, "1/2", "1/2")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                pickup_beats=Fraction(1),
            ),
        )
        out = apply_score_edit(
            doc, _edit("scaleTempo", "", factor="1/2")
        )
        assert out.payload.pickup_beats == Fraction(1, 2)

    def test_whole_pickup_bar_disappears(self) -> None:
        # A full-measure pickup under factor 2 wraps to zero — the
        # anacrusis becomes a complete first measure.
        doc = _doc([_note(1, 60, "0", "4")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                pickup_beats=Fraction(2),
            ),
        )
        out = apply_score_edit(doc, _edit("scaleTempo", "", factor=2))
        assert out.payload.pickup_beats == Fraction(0)

    def test_meter_and_key_changes_rescale(self) -> None:
        ts34 = TimeSignature(beats_per_measure=3, beat_unit=4)
        doc = _doc([_note(1, 60, "0", "4"), _note(2, 62, "4", "3")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                meter_changes=(
                    MeterChange(
                        start_beat=Fraction(0),
                        time_signature=TimeSignature(
                            beats_per_measure=4, beat_unit=4
                        ),
                    ),
                    MeterChange(
                        start_beat=Fraction(4),
                        time_signature=ts34,
                    ),
                ),
                key_changes=(
                    KeyChange(
                        start_beat=Fraction(0),
                        key_signature=KeySignature(fifths=0, mode="major"),
                    ),
                    KeyChange(
                        start_beat=Fraction(4),
                        key_signature=KeySignature(fifths=2, mode="major"),
                    ),
                ),
            ),
        )
        out = apply_score_edit(doc, _edit("scaleTempo", "", factor=2))
        changes = out.payload.meter_changes
        assert [c.start_beat for c in changes] == [
            Fraction(0),
            Fraction(8),
        ]
        assert [c.start_beat for c in out.payload.key_changes] == [
            Fraction(0),
            Fraction(8),
        ]
        # The 3/4 segment still starts on a downbeat.
        assert changes[1].measure_phase_beats == Fraction(0)

    def test_tempo_map_segments_rescale(self) -> None:
        doc = _doc([_note(1, 60, "0", "8")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                tempo_map=(
                    TempoSegment(start_beat=Fraction(0), bpm=240.0),
                    TempoSegment(start_beat=Fraction(4), bpm=220.0),
                ),
            ),
        )
        out = apply_score_edit(
            doc, _edit("scaleTempo", "", factor="1/2")
        )
        segs = out.payload.tempo_map
        assert [s.start_beat for s in segs] == [Fraction(0), Fraction(2)]
        assert [s.bpm for s in segs] == [120.0, 110.0]

    def test_factor_validation(self) -> None:
        with pytest.raises(ScoreEditError, match="factor"):
            ScoreEdit.from_dict({"kind": "scaleTempo", "noteId": ""})
        for bad in (0, -1, "1/9", 16, "fast", True):
            with pytest.raises(ScoreEditError):
                ScoreEdit.from_dict(
                    {"kind": "scaleTempo", "noteId": "", "factor": bad}
                )

    def test_note_ids_survive(self) -> None:
        doc = _doc([_note(1, 60, "0", "2"), _note(2, 62, "2", "2")])
        out = apply_score_edit(
            doc, _edit("scaleTempo", "", factor="1/2")
        )
        assert [n.id for n in out.payload.parts[0].notes] == [
            ScoreNoteId("sn-000001"),
            ScoreNoteId("sn-000002"),
        ]


class TestApplyAlternative:
    """#208: swap in the runner-up rhythm for an ambiguous run."""

    def test_swaps_spans_and_retiles(self) -> None:
        # Coin-flip onset: written at 0, the alternative puts it at 1/4
        # with a longer span. Ids survive; the window re-tiles.
        doc = _doc([_note(1, 60, "0", "1/2"), _note(2, 62, "1", "1")])
        out = apply_score_edit(
            doc,
            _edit(
                "applyAlternative",
                "",
                notes=[
                    {
                        "id": "sn-000001",
                        "startBeat": "1/4",
                        "durationBeats": "3/4",
                    }
                ],
            ),
        )
        part = out.payload.parts[0]
        n1 = part.notes[0]
        assert n1.id == ScoreNoteId("sn-000001")
        assert n1.start_beat == Fraction(1, 4)
        assert n1.duration_beats == Fraction(3, 4)
        assert sum(a.duration_beats for a in n1.atoms) == n1.duration_beats
        # The freed 0..1/4 becomes a rest; the measure still tiles.
        assert any(
            r.start_beat == Fraction(0) and r.end_beat == Fraction(1, 4)
            for r in part.rests
        )
        assert out.revision != doc.revision

    def test_overlap_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1"), _note(2, 62, "1", "1")])
        with pytest.raises(ScoreEditError, match="overlap"):
            apply_score_edit(
                doc,
                _edit(
                    "applyAlternative",
                    "",
                    notes=[
                        {
                            "id": "sn-000001",
                            "startBeat": "0",
                            "durationBeats": "3/2",
                        }
                    ],
                ),
            )

    def test_unknown_id_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        with pytest.raises(ScoreEditError, match="not found"):
            apply_score_edit(
                doc,
                _edit(
                    "applyAlternative",
                    "",
                    notes=[
                        {
                            "id": "sn-999999",
                            "startBeat": "0",
                            "durationBeats": "1",
                        }
                    ],
                ),
            )

    def test_notes_validation(self) -> None:
        with pytest.raises(ScoreEditError, match="notes"):
            ScoreEdit.from_dict({"kind": "applyAlternative", "noteId": ""})
        for bad in (
            [],
            [{}],
            [{"id": "sn-1"}],
            [{"id": "", "startBeat": "0", "durationBeats": "1"}],
            [{"id": "sn-1", "startBeat": "0", "durationBeats": "0"}],
            [{"id": "sn-1", "startBeat": "x", "durationBeats": "1"}],
        ):
            with pytest.raises(ScoreEditError):
                ScoreEdit.from_dict(
                    {"kind": "applyAlternative", "noteId": "", "notes": bad}
                )


class TestApplyTriplet:
    """#212: force one beat into triplet notation."""

    def test_region_rewrites_to_triplets(self) -> None:
        # Three eighth-triplet positions written straight: forcing the
        # region re-decomposes them as a triplet group.
        doc = _doc(
            [
                _note(1, 60, "0", "1/3"),
                _note(2, 62, "1/3", "1/3"),
                _note(3, 64, "2/3", "1/3"),
            ]
        )
        out = apply_score_edit(
            doc, _edit("applyTriplet", "", startBeat="0")
        )
        part = out.payload.parts[0]
        triplet_atoms = [
            a for n in part.notes for a in n.atoms if a.tuplet
        ]
        assert triplet_atoms, "expected triplet atoms after applyTriplet"
        assert out.revision != doc.revision

    def test_outside_region_untouched(self) -> None:
        doc = _doc(
            [
                _note(1, 60, "0", "1/3"),
                _note(2, 62, "1/3", "1/3"),
                _note(3, 64, "2/3", "1/3"),
                _note(4, 65, "1", "1"),
            ]
        )
        out = apply_score_edit(
            doc, _edit("applyTriplet", "", startBeat="0")
        )
        part = out.payload.parts[0]
        assert part.notes[3].start_beat == Fraction(1)
        assert part.notes[3].duration_beats == Fraction(1)

    def test_compound_meter_rejected(self) -> None:
        doc = _doc([_note(1, 60, "0", "1")])
        doc = replace(
            doc,
            payload=replace(
                doc.payload,
                time_signature=TimeSignature(
                    beats_per_measure=6, beat_unit=8
                ),
            ),
        )
        with pytest.raises(ScoreEditError, match="compound"):
            apply_score_edit(
                doc, _edit("applyTriplet", "", startBeat="0")
            )

    def test_requires_start_beat(self) -> None:
        with pytest.raises(ScoreEditError, match="startBeat"):
            ScoreEdit.from_dict({"kind": "applyTriplet", "noteId": ""})
