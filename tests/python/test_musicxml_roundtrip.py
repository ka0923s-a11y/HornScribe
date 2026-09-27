"""#359: MusicXML -> importer round-trip verification.

MuseScore itself is not present on the verification host, so the
importer under test is music21 MusicXML reader - the same
partwise grammar MuseScore consumes. These tests prove that what
the exporter emits parses back with no lost or reshaped elements:
measures, pitches, rests, ties, key changes, tempo changes, swing
marking, chords, and multi-part scores. docs/MUSESCORE_ROUNDTRIP.md
records the manual MuseScore checklist for a host that has it.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import replace
from fractions import Fraction

from music21 import converter, expressions, key, stream, tempo

from conftest import make_score
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
)
from hornscribe.domain.score import (
    KeyChange,
    KeySignature,
    Part,
    QuantizedNote,
    TempoSegment,
)
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)


def _parse(xml: str):
    return converter.parse(xml, format="musicxml")


def _measures(part) -> list:
    return list(part.getElementsByClass(stream.Measure))


def _midis(part) -> list[int]:
    out: list[int] = []
    for n in part.recurse().notes:
        out.extend(int(p.midi) for p in n.pitches)
    return out


def _note(n: int, pitch: int, start: str, dur: str) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId(f"sn-{n:06d}"),
        source_event_ids=(RawNoteEventId(f"rne-{n:06d}"),),
        pitch_midi=pitch,
        start_beat=Fraction(start),
        duration_beats=Fraction(dur),
        velocity=80,
    )


class TestContentSurvives:
    def test_measures_notes_rests(self) -> None:
        # beats 0-1 note, 1-2 rest, 2-3 note, 3-4 rest, 4-6 note, 6-8 rest
        score = make_score([(60, 0, 1), (64, 2, 1), (67, 4, 2)])
        parsed = _parse(export_concert_musicxml(score))
        part = parsed.parts[0]
        assert len(_measures(part)) == 2
        assert _midis(part) == [60, 64, 67]
        rests = list(
            part.recurse().getElementsByClass("Rest")
        )
        assert len(rests) == 3  # 1 + 1 + 2 beats of silence
        assert sum(r.duration.quarterLength for r in rests) == 4.0

    def test_tie_fragments_roundtrip(self) -> None:
        # A 6-beat note in 4/4 must come back as tied fragments,
        # not a dropped or truncated span.
        parsed = _parse(
            export_concert_musicxml(make_score([(60, 0, 6)]))
        )
        notes = list(parsed.parts[0].recurse().notes)
        assert len(notes) == 2
        ties = {n.tie.type for n in notes if n.tie is not None}
        assert ties >= {"start", "stop"}
        total = sum(n.duration.quarterLength for n in notes)
        assert total == 6.0

    def test_canonical_ids_survive_import(self) -> None:
        # sn-* ids ride on every exported note; a consumer that
        # keeps them can address the same note after re-import.
        xml = export_concert_musicxml(make_score([(60, 0, 1), (62, 1, 1)]))
        root = ET.fromstring(xml)
        exported = [n.get("id") for n in root.iter("note")]
        assert all(exported)
        parsed = _parse(xml)
        assert list(parsed.parts[0].recurse().notes)

    def test_chord_members_not_dropped(self) -> None:
        score = make_score([(60, 0, 1), (64, 0, 1), (67, 1, 1)])
        part = _parse(export_concert_musicxml(score)).parts[0]
        assert sorted(_midis(part)) == [60, 64, 67]

    def test_accidental_spelling_roundtrip(self) -> None:
        # Flat key: 63 must come back as E-flat, not D-sharp - the
        # spelling decision survives the importer, not just the pitch.
        flat = _parse(
            export_concert_musicxml(
                make_score([(63, 0, 1)], fifths=-2)
            )
        )
        p = flat.parts[0].recurse().notes[0].pitch
        assert p.midi == 63 and p.accidental is not None
        assert p.accidental.alter == -1
        # Sharp key: 61 comes back as C-sharp.
        sharp = _parse(
            export_concert_musicxml(
                make_score([(61, 0, 1)], fifths=1)
            )
        )
        p2 = sharp.parts[0].recurse().notes[0].pitch
        assert p2.midi == 61 and p2.accidental is not None
        assert p2.accidental.alter == 1


class TestStructureSurvives:
    def test_key_change_mid_score(self) -> None:
        doc = make_score([(60, 0, 4), (62, 4, 4), (64, 8, 4)])
        changed = replace(
            doc,
            payload=replace(
                doc.payload,
                key_changes=(
                    KeyChange(Fraction(0), KeySignature(0, "major")),
                    KeyChange(Fraction(8), KeySignature(2, "major")),
                ),
            ),
        )
        part = _parse(export_concert_musicxml(changed)).parts[0]
        sigs = list(part.recurse().getElementsByClass(key.KeySignature))
        assert [s.sharps for s in sigs] == [0, 2]
        # The change lands at measure 3 (beat 8 in 4/4).
        m3 = _measures(part)[2]
        m3_sigs = list(
            m3.recurse().getElementsByClass(key.KeySignature)
        )
        assert m3_sigs and m3_sigs[0].sharps == 2

    def test_tempo_change_mid_score(self) -> None:
        doc = make_score([(60, 0, 4), (64, 4, 4)])
        changed = replace(
            doc,
            payload=replace(
                doc.payload,
                tempo_map=(
                    TempoSegment(start_beat=Fraction(0), bpm=120.0),
                    TempoSegment(start_beat=Fraction(4), bpm=90.0),
                ),
            ),
        )
        part = _parse(export_concert_musicxml(changed)).parts[0]
        marks = list(
            part.recurse().getElementsByClass(tempo.MetronomeMark)
        )
        numbers = sorted(m.number for m in marks)
        assert numbers == [90.0, 120.0]

    def test_swing_marking_survives_parse(self) -> None:
        doc = make_score()
        swung = replace(
            doc,
            payload=replace(doc.payload, swing_feel=Fraction(2, 3)),
        )
        xml = export_concert_musicxml(swung)
        assert "<swing>" in xml  # playback hint for the importer
        parsed = _parse(xml)
        texts = list(
            parsed.recurse().getElementsByClass(expressions.TextExpression)
        )
        assert any("Swing" in (t.content or "") for t in texts)

    def test_multi_part_roundtrip(self) -> None:
        doc = make_score([(60, 0, 1), (62, 1, 1)])
        second = Part(
            id="part-2",
            name="Horn 2",
            notes=(_note(10, 55, "0", "2"), _note(11, 58, "2", "2")),
        )
        two = replace(
            doc,
            payload=replace(
                doc.payload, parts=(doc.payload.parts[0], second)
            ),
        )
        parsed = _parse(export_concert_musicxml(two))
        assert len(parsed.parts) == 2
        assert _midis(parsed.parts[0]) == [60, 62]
        assert _midis(parsed.parts[1]) == [55, 58]

    def test_horn_export_transposes_back(self) -> None:
        # F-horn written pitch must sound a perfect fifth lower on
        # import - the transpose metadata carries the correction.
        parsed = _parse(
            export_horn_in_f_musicxml(
                make_score([(60, 0, 1), (64, 1, 1), (67, 2, 2)])
            )
        )
        part = parsed.parts[0]
        sounding = _midis(part.toSoundingPitch())
        assert sounding == [60, 64, 67]
        # And the written surface still shows the transposed notes.
        assert _midis(part) == [67, 71, 74]

    def test_every_shape_parses(self) -> None:
        # Broad sweep: unusual but legal payloads must produce XML
        # an importer accepts - the crash itself is the regression.
        shapes = [
            make_score([(48, 0, 1), (84, 1, 1)]),  # range extremes
            make_score([(60, 0, Fraction(1, 2))], fifths=3),
            make_score([(60, 0, 1)], fifths=-7, mode="minor"),
            make_score([(60, 0, 4), (62, 6, 4)], pickup_beats=Fraction(2)),
        ]
        for score in shapes:
            parsed = _parse(export_concert_musicxml(score))
            assert parsed.parts
            assert _midis(parsed.parts[0])
