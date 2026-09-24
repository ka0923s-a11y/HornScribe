"""#155: in-part chords — same-rhythm simultaneities render as <chord/>.

The chords texture merges split voices into one part; the notation
layer groups notes sharing (start, duration, atoms) into chord.Chord
members and lifts other overlaps into secondary voices (<backup>).
"""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    TranscriptionRevisionId,
)
from hornscribe.domain.score import (
    KeySignature,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
    note_layers,
)
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    iter_exported_notes,
    verify_rhythm_roundtrip,
)
from hornscribe.rhythm.contracts import (
    QuantizationAlternative,
    QuantizedRhythmNote,
)
from hornscribe.rhythm.meter import MeterSegment
from hornscribe.transcription.scorebuild import build_score
from hornscribe.transcription.scoreedit import (
    ScoreEdit,
    apply_score_edit,
)

# --- end-to-end pipeline (fake backend) ----------------------------------------


def _e2e_events() -> tuple[RawNoteEvent, ...]:
    """Two simultaneous quarter-note lines at 120bpm (0.5s beats)."""
    rev = TranscriptionRevisionId("tr-000001")

    def ev(i: int, pitch: int, onset: float, offset: float) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-{i:06d}"),
            transcription_revision=rev,
            pitch_midi=float(pitch),
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.9,
            velocity=80,
            source="test",
        )

    return (
        ev(1, 72, 0.0, 0.5),
        ev(2, 74, 0.5, 1.0),
        ev(3, 60, 0.0, 0.5),
        ev(4, 62, 0.5, 1.0),
    )


class TestChordsPipeline:
    def test_chords_texture_merges_into_one_part(self, tmp_path) -> None:
        import threading
        from array import array

        from hornscribe.transcription.options import TranscriptionParams
        from hornscribe.transcription.pipeline import run_transcription_job

        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected: list[dict] = []

        def emit(phase: str, **kw) -> None:
            collected.append({"phase": phase, **kw})

        events = _e2e_events()
        params = TranscriptionParams.from_payload(
            {
                "audioPath": str(audio),
                "tempoBpm": 120.0,
                "meter": "4/4",
                "texture": "chords",
            }
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=lambda _p: events,
            loader=lambda _p: (array("f", [0.0] * (22050 * 5)), 22050),
        )
        assert collected[-1]["phase"] == "completed"
        result = collected[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 1
        assert len(parts[0]["notes"]) == 4
        assert "<chord />" in result["musicXmlConcert"]

    def test_voices_texture_still_splits_parts(self, tmp_path) -> None:
        import threading
        from array import array

        from hornscribe.transcription.options import TranscriptionParams
        from hornscribe.transcription.pipeline import run_transcription_job

        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected: list[dict] = []

        def emit(phase: str, **kw) -> None:
            collected.append({"phase": phase, **kw})

        events = _e2e_events()
        params = TranscriptionParams.from_payload(
            {
                "audioPath": str(audio),
                "tempoBpm": 120.0,
                "meter": "4/4",
                "texture": "voices",
            }
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=lambda _p: events,
            loader=lambda _p: (array("f", [0.0] * (22050 * 5)), 22050),
        )
        assert collected[-1]["phase"] == "completed"
        result = collected[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 2


def _qn(n: int, pitch: int, start: str, dur: str, **kw: object) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId(f"sn-{n:06d}"),
        source_event_ids=(RawNoteEventId(f"rne-{n:06d}"),),
        pitch_midi=pitch,
        start_beat=Fraction(start),
        duration_beats=Fraction(dur),
        **kw,  # type: ignore[arg-type]
    )


class TestNoteLayers:
    def test_monophonic_is_all_layer_zero(self) -> None:
        notes = (_qn(1, 60, "0", "1"), _qn(2, 62, "1", "1"))
        assert note_layers(notes) == {
            ScoreNoteId("sn-000001"): 0,
            ScoreNoteId("sn-000002"): 0,
        }

    def test_chord_members_share_layer_zero(self) -> None:
        notes = (
            _qn(1, 60, "0", "1"),
            _qn(2, 64, "0", "1"),
            _qn(3, 67, "0", "1"),
            _qn(4, 72, "1", "1"),
        )
        layers = note_layers(notes)
        assert layers[ScoreNoteId("sn-000001")] == 0
        assert layers[ScoreNoteId("sn-000002")] == 0
        assert layers[ScoreNoteId("sn-000003")] == 0
        assert layers[ScoreNoteId("sn-000004")] == 0

    def test_non_chord_overlap_gets_second_layer(self) -> None:
        notes = (_qn(1, 60, "0", "2"), _qn(2, 64, "1", "1"))
        layers = note_layers(notes)
        assert layers[ScoreNoteId("sn-000001")] == 0
        assert layers[ScoreNoteId("sn-000002")] == 1

    def test_same_start_different_duration_is_not_a_chord(self) -> None:
        notes = (_qn(1, 60, "0", "2"), _qn(2, 64, "0", "1"))
        layers = note_layers(notes)
        assert layers[ScoreNoteId("sn-000001")] != layers[
            ScoreNoteId("sn-000002")
        ]

    def test_layer_is_reused_after_it_frees(self) -> None:
        notes = (
            _qn(1, 60, "0", "4"),
            _qn(2, 64, "1", "1"),
            _qn(3, 65, "2", "1"),
        )
        layers = note_layers(notes)
        assert layers[ScoreNoteId("sn-000002")] == 1
        assert layers[ScoreNoteId("sn-000003")] == 1


# --- build_score merge_voices -------------------------------------------------


def _alt(spec: list[tuple[int, str, str]], start_id: int) -> QuantizationAlternative:
    """(pitch, onset_ql, dur_ql) rows -> a rank-1 alternative (no atoms)."""
    return QuantizationAlternative(
        rank=1,
        total_cost=0.0,
        notes=tuple(
            QuantizedRhythmNote(
                canonical_note_id=ScoreNoteId(f"sn-{start_id + i:06d}"),
                source_event_ids=(RawNoteEventId(f"rne-{start_id + i:06d}"),),
                onset_ql=Fraction(onset),
                duration_ql=Fraction(dur),
            )
            for i, (_pitch, onset, dur) in enumerate(spec)
        ),
    )


def _events(spec: list[tuple[int, str, str]], start_id: int) -> dict:
    rev = TranscriptionRevisionId("tr-000001")
    return {
        RawNoteEventId(f"rne-{start_id + i:06d}"): RawNoteEvent(
            id=RawNoteEventId(f"rne-{start_id + i:06d}"),
            transcription_revision=rev,
            pitch_midi=float(pitch),
            onset_sec=float(Fraction(onset)),
            offset_sec=float(Fraction(onset) + Fraction(dur)),
            confidence=0.9,
            velocity=80,
            source="test",
        )
        for i, (pitch, onset, dur) in enumerate(spec)
    }


def _build(
    upper: list[tuple[int, str, str]],
    lower: list[tuple[int, str, str]],
    merge: bool,
):
    event_by_id = {**_events(upper, 1), **_events(lower, 100)}
    return build_score(
        _alt(upper, 1),
        MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4),
        (TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        KeySignature(fifths=0, mode="major"),
        event_by_id=event_by_id,
        title="t",
        source_audio_path="a.wav",
        source_audio_hash=None,
        settings={},
        extra_voices=(_alt(lower, 100),),
        merge_voices=merge,
    )


class TestMergeVoices:
    def test_merged_into_one_part(self) -> None:
        built = _build(
            [(72, "0", "1"), (74, "1", "1")],
            [(60, "0", "1"), (62, "1", "1")],
            merge=True,
        )
        assert len(built.payload.parts) == 1
        notes = built.payload.parts[0].notes
        assert len(notes) == 4
        # Sorted by (start, pitch): the low voice slots under the top.
        assert [(n.pitch_midi, n.start_beat) for n in notes] == [
            (60, Fraction(0)),
            (72, Fraction(0)),
            (62, Fraction(1)),
            (74, Fraction(1)),
        ]

    def test_unmerged_stays_two_parts(self) -> None:
        built = _build(
            [(72, "0", "1")], [(60, "0", "1")], merge=False
        )
        assert len(built.payload.parts) == 2

    def test_merged_ids_are_unique(self) -> None:
        built = _build(
            [(72, "0", "1")], [(60, "0", "1")], merge=True
        )
        ids = [n.id for n in built.payload.parts[0].notes]
        assert len(ids) == len(set(ids))


# --- notation / export --------------------------------------------------------


def _doc(notes: list[QuantizedNote], rests: tuple = ()):
    from hornscribe.domain.ids import ProjectId
    from hornscribe.domain.score import ScoreDocument

    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="part-1", name="Horn in F", notes=tuple(notes), rests=rests),),
        quantization_settings={},
    )
    return ScoreDocument(
        project_id=ProjectId("proj-test"), payload=payload, title="t"
    )


class TestChordExport:
    def test_chord_roundtrips_through_verification(self) -> None:
        doc = _doc(
            [
                _qn(1, 60, "0", "1"),
                _qn(2, 64, "0", "1"),
                _qn(3, 67, "0", "1"),
                _qn(4, 72, "1", "1"),
            ]
        )
        xml = export_concert_musicxml(doc)
        assert xml.count("<chord />") == 2
        pitched = [n for n in iter_exported_notes(xml) if n.written_midi]
        assert {n.canonical_id for n in pitched} == {
            ScoreNoteId(f"sn-{i:06d}") for i in range(1, 5)
        }

    def test_mixed_chords_and_voices_roundtrip(self) -> None:
        """A chord plus a misaligned second voice: <chord/> inside
        voice structure, all notes verified.  Canonical rests make the
        score strict so the layer-0 trailing gap is real content."""
        rest_atom = ScoreAtom(duration_beats=Fraction(2), symbol="half")
        doc = _doc(
            [
                _qn(1, 72, "0", "2"),   # held top note
                _qn(2, 60, "0", "1"),   # lower voice, half the span
                _qn(3, 64, "0", "1"),   # chord member with sn-000002
                _qn(4, 62, "1", "1"),   # lower voice continues
            ],
            rests=(
                ScoreRest(start_beat=Fraction(2), atoms=(rest_atom,)),
            ),
        )
        xml = export_concert_musicxml(doc)
        assert "<chord />" in xml
        assert "<backup>" in xml
        assert verify_rhythm_roundtrip(doc, xml) == []

    def test_strict_chord_score_roundtrip(self) -> None:
        """Chord members with committed atoms + canonical rests — the
        strict tiling path must accept same-onset groups."""
        atom = ScoreAtom(duration_beats=Fraction(1), symbol="quarter")
        rest_atom = ScoreAtom(duration_beats=Fraction(2), symbol="half")
        doc = _doc(
            [
                _qn(1, 60, "0", "1", atoms=(atom,)),
                _qn(2, 64, "0", "1", atoms=(atom,)),
                _qn(3, 67, "1", "1", atoms=(atom,)),
            ],
            rests=(
                ScoreRest(start_beat=Fraction(2), atoms=(rest_atom,)),
            ),
        )
        xml = export_concert_musicxml(doc)
        assert xml.count("<chord />") == 1
        assert verify_rhythm_roundtrip(doc, xml) == []

    def test_hidden_gap_rest_stays_out_of_rest_ordinals(self) -> None:
        """#241: a secondary-voice gap filler must not consume an
        hs-rest-* ordinal — the frontend resolves hs-rest-N to the
        N-th canonical rest atom, so a filler before a canonical rest
        would shift its target."""
        atom = ScoreAtom(duration_beats=Fraction(2), symbol="half")
        rest_atom = ScoreAtom(duration_beats=Fraction(1), symbol="quarter")
        doc = _doc(
            [
                # The LONGER note must carry the lower pitch — layers
                # are allocated lowest-pitch-first, so the sustained
                # voice stays on layer 0 where canonical rests tile.
                _qn(1, 60, "0", "2", atoms=(atom,)),   # held low note
                _qn(2, 72, "0", "1",
                    atoms=(ScoreAtom(duration_beats=Fraction(1),
                                     symbol="quarter"),)),
                _qn(3, 67, "5", "1", atoms=(rest_atom,)),
            ],
            rests=(
                # Canonical rests tile every measure in strict mode:
                # m1 [2,4), m2 [4,5) + [6,8) — three rest atoms total.
                ScoreRest(
                    start_beat=Fraction(2),
                    atoms=(ScoreAtom(duration_beats=Fraction(2),
                                     symbol="half"),),
                ),
                ScoreRest(start_beat=Fraction(4), atoms=(rest_atom,)),
                ScoreRest(
                    start_beat=Fraction(6),
                    atoms=(ScoreAtom(duration_beats=Fraction(2),
                                     symbol="half"),),
                ),
            ),
        )
        xml = export_concert_musicxml(doc)
        # The layer-1 gap at beats [1,2) renders print-object=no and
        # carries a layout id — the three canonical rests keep
        # ordinals 1-3 even though the filler precedes them in
        # document order.
        assert 'id="hs-layout-rest-000001"' in xml
        assert 'id="hs-rest-000001"' in xml
        assert 'id="hs-rest-000003"' in xml
        assert 'id="hs-rest-000004"' not in xml
        assert verify_rhythm_roundtrip(doc, xml) == []


# --- edits on chord parts -----------------------------------------------------


class TestChordEdits:
    def test_shortening_a_member_does_not_clip_siblings(self) -> None:
        doc = _doc(
            [
                _qn(1, 60, "0", "1"),
                _qn(2, 64, "0", "1"),
                _qn(3, 67, "1", "1"),
            ]
        )
        out = apply_score_edit(
            doc,
            ScoreEdit.from_dict(
                {"kind": "setDuration", "noteId": "sn-000001",
                 "durationBeats": "1/2"}
            ),
        )
        by_id = {n.id: n for n in out.payload.parts[0].notes}
        # The sibling keeps its full span — the old monophonic clip
        # would have zeroed it out and raised.
        assert by_id[ScoreNoteId("sn-000002")].duration_beats == Fraction(1)
        assert by_id[ScoreNoteId("sn-000001")].duration_beats == Fraction(1, 2)

    def test_extending_past_next_onset_still_rejected(self) -> None:
        doc = _doc(
            [
                _qn(1, 60, "0", "1"),
                _qn(2, 64, "0", "1"),
                _qn(3, 67, "1", "1"),
            ]
        )
        with pytest.raises(Exception, match="extends past"):
            apply_score_edit(
                doc,
                ScoreEdit.from_dict(
                    {"kind": "setDuration", "noteId": "sn-000001",
                     "durationBeats": "2"}
                ),
            )
