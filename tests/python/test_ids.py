"""FND-001: deterministic identity rules."""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.ids import (
    IdAllocator,
    RawNoteEventId,
    ScoreNoteId,
    canonical_note_id_from_musicxml,
    derive_project_id,
    derive_score_revision_id,
    derive_transcription_revision_id,
    is_musicxml_note_id,
    is_project_id,
    is_raw_note_event_id,
    is_score_note_id,
    is_score_revision_id,
    is_transcription_revision_id,
    musicxml_note_id,
)
from hornscribe.domain.score import (
    KeySignature,
    Part,
    QuantizedNote,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
)


def test_allocator_sequential_and_typed() -> None:
    alloc = IdAllocator("rne")
    assert alloc.allocate_raw_event_id() == "rne-000001"
    assert alloc.allocate_raw_event_id() == "rne-000002"
    alloc = IdAllocator("sn")
    assert alloc.allocate_score_note_id() == "sn-000001"


def test_allocator_rejects_unknown_prefix() -> None:
    with pytest.raises(ValueError, match="unknown id prefix"):
        IdAllocator("xyz")


def test_typed_allocator_rejects_wrong_type() -> None:
    with pytest.raises(TypeError):
        IdAllocator("rne").allocate_score_note_id()


def test_id_validators() -> None:
    assert is_raw_note_event_id("rne-000042")
    assert not is_raw_note_event_id("sn-000042")
    assert is_score_note_id("sn-000042")
    assert is_score_revision_id("rev-" + "a" * 16)
    assert not is_score_revision_id("rev-XYZ")
    assert is_transcription_revision_id("tr-" + "0" * 16)
    assert is_project_id("prj-" + "f" * 16)


def test_revision_ids_are_content_derived() -> None:
    a = derive_score_revision_id({"x": 1, "y": [1, 2]})
    b = derive_score_revision_id({"y": [1, 2], "x": 1})  # key order irrelevant
    c = derive_score_revision_id({"x": 2})
    assert a == b
    assert a != c


def test_transcription_revision_deterministic() -> None:
    a = derive_transcription_revision_id({"backend": "basic_pitch", "v": "0.4.0"})
    assert a == derive_transcription_revision_id({"v": "0.4.0", "backend": "basic_pitch"})
    assert is_transcription_revision_id(a)


def test_project_id_deterministic() -> None:
    assert derive_project_id({"seed": 1}) == derive_project_id({"seed": 1})


def _payload(note_pitch: int = 60) -> ScoreRevisionPayload:
    alloc = IdAllocator("sn")
    note = QuantizedNote(
        id=ScoreNoteId(alloc.allocate()),
        source_event_ids=(RawNoteEventId("rne-000001"),),
        pitch_midi=note_pitch,
        start_beat=Fraction(0),
        duration_beats=Fraction(1),
    )
    return ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(4, 4),
        key_signature=KeySignature(0, "major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="p1", name="Horn", notes=(note,)),),
        quantization_settings={"grid": "1/16"},
    )


def test_requantization_creates_new_revision() -> None:
    p1 = _payload()
    p2 = ScoreRevisionPayload(
        tempo_map=p1.tempo_map,
        time_signature=p1.time_signature,
        key_signature=p1.key_signature,
        pickup_beats=p1.pickup_beats,
        parts=p1.parts,
        quantization_settings={"grid": "1/8"},  # different settings, same notes
    )
    assert p1.revision_id() != p2.revision_id()
    assert p1.revision_id() == _payload().revision_id()  # reproducible


def test_musicxml_note_id_round_trip() -> None:
    note_id = ScoreNoteId("sn-000042")
    export_id = musicxml_note_id(note_id)
    assert export_id == "hs-sn-000042"
    assert is_musicxml_note_id(export_id)
    assert canonical_note_id_from_musicxml(export_id) == note_id


def test_musicxml_note_id_rejects_noncanonical() -> None:
    with pytest.raises(ValueError):
        musicxml_note_id(ScoreNoteId("bogus"))
    with pytest.raises(ValueError):
        canonical_note_id_from_musicxml("not-an-export-id")
