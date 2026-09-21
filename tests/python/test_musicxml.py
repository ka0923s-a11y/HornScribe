"""ENG-001: MusicXML 4.0 export — identity, transpose metadata, round-trip."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

import pytest
from music21 import converter

from conftest import make_score
from hornscribe.domain.ids import (
    canonical_note_id_from_musicxml,
    is_musicxml_rest_id,
)
from hornscribe.domain.score import PitchSpace
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
    export_musicxml,
    iter_exported_notes,
)
from hornscribe.notation.to_music21 import NotationError

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "musicxml"


def _root(xml: str) -> ET.Element:
    return ET.fromstring(xml)


def _all_note_ids(xml: str) -> list[str]:
    return [n.get("id") or "" for n in _root(xml).iter("note")]


def _fifths(xml: str) -> int:
    el = _root(xml).find("part/measure/attributes/key/fifths")
    assert el is not None and el.text is not None
    return int(el.text)


def _transpose(xml: str) -> tuple[str | None, str | None]:
    t = _root(xml).find("part/measure/attributes/transpose")
    assert t is not None
    return (t.findtext("diatonic"), t.findtext("chromatic"))


def _pitched(xml: str):
    return [n for n in iter_exported_notes(xml) if n.written_midi is not None]


# --- document shape ------------------------------------------------------------


def test_output_is_musicxml_40() -> None:
    xml = export_concert_musicxml(make_score())
    assert xml.startswith('<?xml version="1.0" encoding="utf-8"?>')
    assert 'DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0' in xml
    assert _root(xml).get("version") == "4.0"


def test_export_is_byte_deterministic() -> None:
    score = make_score([(60, 0, 1), (64, 1, 1), (67, 2, 2)])
    assert export_horn_in_f_musicxml(score) == export_horn_in_f_musicxml(score)
    assert export_concert_musicxml(score) == export_concert_musicxml(score)


def test_every_note_element_has_an_id() -> None:
    xml = export_horn_in_f_musicxml(
        make_score([(60, 0, 1), (64, Fraction(3), 3)])  # gap -> rest
    )
    ids = _all_note_ids(xml)
    assert all(ids)
    assert len(ids) == len(set(ids))  # xs:ID uniqueness


def test_rests_have_presentation_ids() -> None:
    xml = export_concert_musicxml(make_score([(60, 0, 1), (64, 3, 1)]))
    rest_ids = [i for i in _all_note_ids(xml) if i.startswith("hs-rest-")]
    assert rest_ids
    assert all(is_musicxml_rest_id(i) for i in rest_ids)


def test_deterministic_part_and_instrument_ids() -> None:
    xml = export_horn_in_f_musicxml(make_score())
    assert '<part id="P1">' in xml
    assert '<score-part id="P1">' in xml
    assert '<score-instrument id="I1">' in xml


# --- golden invariants ---------------------------------------------------------


def test_horn_written_pitch_golden() -> None:
    """Concert C4/F#4/Bb3 -> written G4/C#5/F4 in Horn MusicXML."""
    score = make_score([(60, 0, 1), (66, 1, 1), (58, 2, 1)])
    notes = _pitched(export_horn_in_f_musicxml(score))
    assert [n.written_midi for n in notes] == [67, 73, 65]


def test_horn_transpose_metadata_is_written_to_sounding() -> None:
    xml = export_horn_in_f_musicxml(make_score())
    assert _transpose(xml) == ("-4", "-7")
    assert "<transpose>" in xml


def test_horn_written_plus_transpose_recovers_sounding() -> None:
    """Horn XML written G4 + chromatic -7 -> sounding C4 (golden chain)."""
    xml = export_horn_in_f_musicxml(make_score([(60, 0, 1)]))
    (n,) = _pitched(xml)
    assert n.written_midi == 67  # written G4
    assert n.sounding_midi == 60  # == canonical concert C4


def test_horn_key_signature_transposed() -> None:
    """C major concert -> fifths=1 (G major) in Horn MusicXML."""
    assert _fifths(export_horn_in_f_musicxml(make_score(fifths=0))) == 1
    assert _fifths(export_horn_in_f_musicxml(make_score(fifths=-1))) == 0
    assert _fifths(export_horn_in_f_musicxml(make_score(fifths=-2))) == -1


def test_concert_export_has_no_transpose() -> None:
    xml = export_concert_musicxml(make_score())
    assert _root(xml).find("part/measure/attributes/transpose") is None
    (n,) = _pitched(xml)
    assert n.written_midi == 60 == n.sounding_midi


def test_concert_export_keeps_concert_key() -> None:
    assert _fifths(export_concert_musicxml(make_score(fifths=-2))) == -2


# --- identity ------------------------------------------------------------------


def test_note_ids_map_to_canonical_ids() -> None:
    score = make_score([(60, 0, 1), (64, 1, 1)])
    xml = export_horn_in_f_musicxml(score)
    canonical = [n.canonical_id for n in _pitched(xml)]
    assert canonical == [n.id for n in score.payload.parts[0].notes]


def test_same_canonical_ids_in_both_presentations() -> None:
    """Concert and Horn share canonical note identity (CONTRACTS §1)."""
    score = make_score([(60, 0, 1), (66, 1, 1), (58, 2, 1)])
    concert_ids = {n.export_id for n in _pitched(export_concert_musicxml(score))}
    horn_ids = {n.export_id for n in _pitched(export_horn_in_f_musicxml(score))}
    assert concert_ids == horn_ids


def test_tied_fragments_carry_fragment_ids() -> None:
    """A note split across a barline emits hs-sn-* plus hs-sn-*-2 fragments."""
    score = make_score([(58, 2, 4)])  # crosses the barline into measure 2
    xml = export_horn_in_f_musicxml(score)
    notes = _pitched(xml)
    ids = [n.export_id for n in notes]
    assert ids[0] == "hs-sn-000001"
    assert len(ids) > 1
    assert all(i == "hs-sn-000001" or i.startswith("hs-sn-000001-") for i in ids)
    # every fragment still resolves to the same canonical note
    assert {n.canonical_id for n in notes} == {score.payload.parts[0].notes[0].id}
    for n in notes:
        assert canonical_note_id_from_musicxml(n.export_id) == n.canonical_id
    # tie is actually emitted
    assert '<tie type="start" />' in xml and '<tie type="stop" />' in xml


def test_canonical_tie_between_distinct_notes_keeps_ids() -> None:
    """tie_start/tie_stop between two canonical notes -> two notes, two IDs."""
    score = make_score([(60, 0, 2), (60, 2, 2)])
    part = score.payload.parts[0]
    notes = (
        replace(part.notes[0], tie_start=True),
        replace(part.notes[1], tie_stop=True),
    )
    part2 = replace(part, notes=notes)
    payload = replace(score.payload, parts=(part2,))
    score = replace(score, payload=payload)
    xml = export_concert_musicxml(score)
    ids = [n.export_id for n in _pitched(xml)]
    assert ids == ["hs-sn-000001", "hs-sn-000002"]
    assert '<tie type="start" />' in xml


# --- round-trip ----------------------------------------------------------------


def test_musicxml_reload_reconstructs_sounding_pitch() -> None:
    """Round-trip: parse exported Horn XML, rebuild sounding pitches."""
    score = make_score([(60, 0, 1), (66, 1, 1), (58, 2, 1)])
    xml = export_horn_in_f_musicxml(score)
    sounding = [n.sounding_midi for n in _pitched(xml)]
    assert sounding == [60, 66, 58]


def test_music21_reload_applies_transpose() -> None:
    """music21 re-import: written G4 + Horn instrument -> sounding C4."""
    xml = export_horn_in_f_musicxml(make_score([(60, 0, 1)]))
    parsed = converter.parse(xml, format="musicxml")
    part = parsed.parts[0]
    written = part.recurse().notes[0]
    assert (written.pitch.nameWithOctave, written.pitch.midi) == ("G4", 67)
    sounding = part.toSoundingPitch().recurse().notes[0]
    assert (sounding.pitch.nameWithOctave, sounding.pitch.midi) == ("C4", 60)


def test_exported_fixtures_parse_and_roundtrip() -> None:
    """Committed fixtures stay valid and identity-bearing."""
    horn = FIXTURE_DIR / "minimal_v1_horn_in_f.musicxml"
    concert = FIXTURE_DIR / "minimal_v1_concert.musicxml"
    for path in (horn, concert):
        if not path.exists():
            pytest.skip("fixtures not generated yet")
        xml = path.read_text(encoding="utf-8")
        assert _root(xml).get("version") == "4.0"
        parsed = converter.parse(xml, format="musicxml")  # raises if invalid
        assert parsed.parts
    horn_notes = _pitched(horn.read_text(encoding="utf-8"))
    assert horn_notes[0].written_midi == 67  # written G4
    assert horn_notes[0].sounding_midi == 60  # sounding C4
    assert canonical_note_id_from_musicxml(horn_notes[0].export_id) == "sn-000001"


def test_golden_fixture_fragments_and_sounding() -> None:
    horn = FIXTURE_DIR / "golden_v1_horn_in_f.musicxml"
    concert = FIXTURE_DIR / "golden_v1_concert.musicxml"
    if not horn.exists():
        pytest.skip("fixtures not generated yet")
    horn_notes = _pitched(horn.read_text(encoding="utf-8"))
    # concert C4 F#4 Bb3 E4 -> written G4 C#5 F4 B4
    assert [n.written_midi for n in horn_notes] == [67, 73, 65, 65, 65, 71]
    assert [n.sounding_midi for n in horn_notes] == [60, 66, 58, 58, 58, 64]
    assert {n.canonical_id for n in horn_notes} == {
        "sn-000001", "sn-000002", "sn-000003", "sn-000004",
    }
    # concert export keeps canonical pitches; ids match horn presentation
    concert_ids = [n.export_id for n in _pitched(concert.read_text(encoding="utf-8"))]
    assert concert_ids == [n.export_id for n in horn_notes]
    converter.parse(concert.read_text(encoding="utf-8"), format="musicxml")


# --- measures / pickup / failure modes -----------------------------------------


def test_measure_count_and_fill() -> None:
    xml = export_concert_musicxml(make_score([(60, 0, 1), (58, 2, 6)]))
    measures = _root(xml).findall("part/measure")
    assert [m.get("number") for m in measures] == ["1", "2"]


def test_pickup_measure_is_implicit() -> None:
    score = make_score([(60, 0, 1), (64, 1, 4)], pickup_beats=Fraction(1))
    xml = export_concert_musicxml(score)
    measures = _root(xml).findall("part/measure")
    assert measures[0].get("number") == "0"
    assert measures[0].get("implicit") == "yes"
    notes = _pitched(xml)
    assert [n.written_midi for n in notes] == [60, 64]


def test_non_concert_document_rejected() -> None:
    score = replace(make_score(), pitch_space=PitchSpace.WRITTEN_HORN_F)
    with pytest.raises(NotationError):
        export_musicxml(score, PitchSpace.CONCERT)


def test_overlapping_notes_rejected() -> None:
    score = make_score([(60, 0, 2), (62, 1, 2)])  # overlapping -> polyphony
    with pytest.raises(NotationError):
        export_concert_musicxml(score)


def test_tempo_mark_exported() -> None:
    xml = export_concert_musicxml(make_score(bpm=96.0))
    assert 'tempo="96"' in xml
    assert "<per-minute>96</per-minute>" in xml
