"""QNT-006: QuantizedRhythmRevision -> music21/MusicXML realization.

Acceptance coverage for issue #20: the committed rhythm (onsets, durations,
rests, ties, tuplets, meter changes) must survive music21 serialization
without silent re-quantization — verified by reloading the exported
MusicXML and comparing against the canonical score.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import rhythm_fixtures as fx
from hornscribe.domain.ids import canonical_note_id_from_musicxml
from hornscribe.domain.score import (
    KeySignature,
    MeterChange,
    Part,
    QuantizedNote,
    ScoreDocument,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
    measure_spans,
)
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
    iter_exported_notes,
    read_exported_rhythm,
    verify_rhythm_roundtrip,
)
from hornscribe.rhythm import normalize_to_score_time, quantize_events
from hornscribe.rhythm._output import assemble_score_document
from rhythm_fixtures import RhythmFixture

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "musicxml"


def _doc_for(fixture: RhythmFixture) -> ScoreDocument:
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    return assemble_score_document(
        alt, notes, fixture.meter_map, bpm=fixture.bpm or 120.0, title=fixture.name
    )


def _root(xml: str) -> ET.Element:
    return ET.fromstring(xml)


# --- full round-trip: every fixture preserves rhythm through MusicXML ----------


@pytest.mark.parametrize(
    "make",
    fx.ALL_FIXTURES,
    ids=[m().name for m in fx.ALL_FIXTURES],
)
def test_rhythm_roundtrip_concert_and_horn(make: Callable[[], RhythmFixture]) -> None:
    """Exported MusicXML reloads to exactly the committed rhythm — in both
    the concert and the Horn in F (transposed) presentation."""
    doc = _doc_for(make())
    assert verify_rhythm_roundtrip(doc, export_concert_musicxml(doc)) == []
    assert verify_rhythm_roundtrip(doc, export_horn_in_f_musicxml(doc)) == []


# --- canonical score bridge ----------------------------------------------------


def test_bridge_carries_atoms_rests_and_ids() -> None:
    """Quantized notes keep canonical ids/source events and gain committed
    atoms; realized rests land on the part."""
    doc = _doc_for(fx.rests_44())
    part = doc.payload.parts[0]
    assert part.rests  # explicit rests present
    for n in part.notes:
        assert str(n.id).startswith("sn-")
        assert n.source_event_ids
        assert n.atoms
        total = sum(a.duration_beats for a in n.atoms)
        assert total == n.duration_beats
        for a in n.atoms[:-1]:
            assert a.tie_to_next


def test_bridge_meter_changes_become_payload_content() -> None:
    doc = _doc_for(fx.meter_change_44_68())
    changes = doc.payload.meter_changes
    assert len(changes) == 2
    assert changes[1].time_signature == TimeSignature(
        beats_per_measure=6, beat_unit=8
    )
    assert changes[1].start_beat == Fraction(8)


def test_score_payload_serializes_atoms_rest_meter_roundtrip() -> None:
    """to_dict/from_dict round-trips the extended canonical model."""
    doc = _doc_for(fx.meter_change_44_68())
    blob = doc.payload.to_dict()
    restored = ScoreRevisionPayload.from_dict(blob)
    assert restored == doc.payload
    # revision id is content-derived: identical payload -> identical id
    assert restored.revision_id() == doc.payload.revision_id()


def test_legacy_payload_unchanged_shape() -> None:
    """Scores without atoms/rests/meter_changes keep their old keys — the
    new fields are omitted so pre-QNT-006 revision IDs stay stable."""
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(
            Part(
                id="p1",
                name="Horn in F",
                notes=(
                    QuantizedNote(
                        id="sn-000001",  # type: ignore[arg-type]
                        source_event_ids=(),
                        pitch_midi=60,
                        start_beat=Fraction(0),
                        duration_beats=Fraction(1),
                    ),
                ),
            ),
        ),
        quantization_settings={},
    )
    blob = payload.to_dict()
    assert "atoms" not in blob["parts"][0]["notes"][0]
    assert "rests" not in blob["parts"][0]
    assert "meterChanges" not in blob


# --- measure layout -------------------------------------------------------------


def test_measure_spans_single_meter_with_pickup() -> None:
    doc = _doc_for(fx.pickup_44_quarter())
    spans = measure_spans(doc.payload)
    assert spans[0].number == 0 and spans[0].implicit
    assert spans[0].start_beat == 0 and spans[0].duration_beats == Fraction(1)
    assert spans[1].number == 1 and spans[1].start_beat == Fraction(1)


def test_measure_spans_meter_change() -> None:
    doc = _doc_for(fx.meter_change_44_68())
    spans = measure_spans(doc.payload)
    sigs = [(s.time_signature.beats_per_measure, s.time_signature.beat_unit)
            for s in spans]
    # canonical beat = quarter (first segment is 4/4), so each 6/8 bar is
    # 3 canonical beats: [8, 11) is a single 6/8 measure.
    assert sigs == [(4, 4), (4, 4), (6, 8)]
    assert spans[2].meter_change and spans[2].start_beat == Fraction(8)
    assert spans[2].duration_beats == Fraction(3)
    assert all(s.duration_beats > 0 for s in spans)


def test_measure_spans_clipped_measure_at_change() -> None:
    """A meter change mid-measure clips the running measure at the change."""
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="p1", name="Horn in F"),),
        quantization_settings={},
        meter_changes=(
            MeterChange(Fraction(0), TimeSignature(4, 4)),
            MeterChange(Fraction(6), TimeSignature(3, 4)),
        ),
    )
    spans = measure_spans(payload)
    # [0,4) 4/4, [4,6) clipped 4/4, then 3/4 measures from 6
    assert [s.duration_beats for s in spans[:3]] == [
        Fraction(4), Fraction(2), Fraction(3)
    ]
    assert spans[2].meter_change


# --- exported MusicXML content ---------------------------------------------------


def test_barline_tie_survives_export() -> None:
    """A note crossing a barline exports as tied fragments sharing the
    canonical id, with stop/start tie linkage."""
    doc = _doc_for(fx.barline_tie_44())
    xml = export_concert_musicxml(doc)
    tied_ids = [
        n.get("id")
        for n in _root(xml).iter("note")
        if n.get("id", "").startswith("hs-sn-000002")
    ]
    assert len(tied_ids) == 2  # split at the barline
    assert canonical_note_id_from_musicxml(tied_ids[1]) == "sn-000002"
    # fragments are tie-joined: stop on the second fragment
    frag2 = next(
        n for n in _root(xml).iter("note") if n.get("id") == tied_ids[1]
    )
    assert {t.get("type") for t in frag2.findall("tie")} == {"stop"}


def test_triplets_emit_time_modification_and_bracket() -> None:
    doc = _doc_for(fx.binary_triplet_binary())
    xml = export_concert_musicxml(doc)
    root = _root(xml)
    mods = root.findall(".//time-modification")
    assert mods  # at least the triplet notes carry it
    assert all(
        m.findtext("actual-notes") == "3" and m.findtext("normal-notes") == "2"
        for m in mods
    )
    assert root.findall(".//notations/tuplet")  # visual brackets present


def test_triplet_durations_are_exact_thirds() -> None:
    doc = _doc_for(fx.binary_triplet_binary())
    measures = read_exported_rhythm(export_concert_musicxml(doc))["P1"]
    thirds = [
        el
        for m in measures
        for el in m.elements
        if el.time_modification is not None
    ]
    assert len(thirds) == 3
    assert all(el.duration_beats == Fraction(1, 3) for el in thirds)


def test_68_has_no_tuplets_and_groups_two_beats() -> None:
    """6/8's native ternary subdivision is meter, not tuplets."""
    doc = _doc_for(fx.meter_68_eighths())
    xml = export_concert_musicxml(doc)
    root = _root(xml)
    assert root.findall(".//time-modification") == []
    ts = root.find("part/measure/attributes/time")
    assert ts is not None
    assert (ts.findtext("beats"), ts.findtext("beat-type")) == ("6", "8")


def test_meter_change_exports_time_attribute() -> None:
    doc = _doc_for(fx.meter_change_44_68())
    xml = export_concert_musicxml(doc)
    sigs = [
        (t.findtext("beats"), t.findtext("beat-type"))
        for t in _root(xml).findall("part/measure/attributes/time")
    ]
    assert sigs == [("4", "4"), ("6", "8")]


def test_explicit_rests_export_and_measure_rest_convention() -> None:
    doc = _doc_for(fx.rests_44())
    xml = export_concert_musicxml(doc)
    root = _root(xml)
    rests = [n for n in root.iter("note") if n.find("rest") is not None]
    assert len(rests) >= 4  # three interior gaps + trailing barline fill
    assert verify_rhythm_roundtrip(doc, xml) == []


def test_pickup_measure_exports_without_hidden_padding() -> None:
    """The implicit pickup measure must not gain a music21 padding rest —
    that was exactly the kind of silent mutation this issue forbids."""
    doc = _doc_for(fx.pickup_44_quarter())
    xml = export_concert_musicxml(doc)
    m0 = _root(xml).find("part/measure")
    assert m0 is not None and m0.get("implicit") == "yes"
    assert len(m0.findall("note")) == 1  # the pickup note, nothing else


def test_canonical_ids_preserved_in_export() -> None:
    doc = _doc_for(fx.meter_34_quarters())
    xml = export_concert_musicxml(doc)
    exported = {n.canonical_id for n in iter_exported_notes(xml)}
    canonical = {n.id for n in doc.payload.parts[0].notes}
    assert exported == canonical


def test_horn_projection_preserves_rhythm_changes_only_pitch() -> None:
    doc = _doc_for(fx.meter_change_44_68())
    concert = iter_exported_notes(export_concert_musicxml(doc))
    horn = iter_exported_notes(export_horn_in_f_musicxml(doc))
    assert [n.canonical_id for n in concert] == [n.canonical_id for n in horn]
    assert [n.written_midi for n in horn if n.written_midi] == [
        n.written_midi + 7 for n in concert if n.written_midi is not None
    ]
    # rhythm identity through the transposed presentation is checked by
    # verify_rhythm_roundtrip in the parametrized test above.


def test_export_is_byte_deterministic() -> None:
    doc = _doc_for(fx.meter_change_44_68())
    assert export_concert_musicxml(doc) == export_concert_musicxml(doc)
    assert export_horn_in_f_musicxml(doc) == export_horn_in_f_musicxml(doc)


# --- mutation detection ------------------------------------------------------------


def test_verify_detects_duration_mutation() -> None:
    """If anything mutates a duration in the XML, verification reports it."""
    doc = _doc_for(fx.meter_34_quarters())
    xml = export_concert_musicxml(doc)
    root = _root(xml)
    dur_el = root.find("part/measure/note/duration")
    assert dur_el is not None and dur_el.text is not None
    dur_el.text = str(int(dur_el.text) * 2)
    broken = ET.tostring(root, encoding="unicode")
    problems = verify_rhythm_roundtrip(doc, broken)
    assert problems


def test_verify_detects_dropped_tuplet() -> None:
    doc = _doc_for(fx.binary_triplet_binary())
    xml = export_concert_musicxml(doc)
    # strip every time-modification: rhythm numbers unchanged but the
    # tuplet intent vanished -> must be flagged
    root = _root(xml)
    for note_el in root.iter("note"):
        tm = note_el.find("time-modification")
        if tm is not None:
            note_el.remove(tm)
    broken = ET.tostring(root, encoding="unicode")
    problems = verify_rhythm_roundtrip(doc, broken)
    assert any("tuplet" in p for p in problems)


# --- import purity -----------------------------------------------------------------


def test_rhythm_package_stays_free_of_music21() -> None:
    """``hornscribe.rhythm`` must not pull in the notation backend."""
    for mod in list(sys.modules):
        if mod == "music21" or mod.startswith("music21."):
            del sys.modules[mod]
    import importlib

    importlib.import_module("hornscribe.rhythm")
    assert "music21" not in sys.modules
