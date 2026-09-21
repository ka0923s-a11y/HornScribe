"""Regenerate committed fixtures deterministically (run from repo root)."""

from __future__ import annotations

import json
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests" / "python"))

import rhythm_fixtures  # noqa: E402
from hornscribe.domain.ids import (  # noqa: E402
    IdAllocator,
    RawNoteEventId,
    ScoreNoteId,
    TranscriptionRevisionId,
    derive_project_id,
    derive_transcription_revision_id,
)
from hornscribe.domain.score import (  # noqa: E402
    KeySignature,
    Part,
    QuantizedNote,
    ScoreDocument,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
)
from hornscribe.export import export_filename  # noqa: E402
from hornscribe.export.musicxml import (  # noqa: E402
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)
from hornscribe.project.model import (  # noqa: E402
    SCHEMA_VERSION,
    HornScribeProject,
    ScoreRef,
    SourceAudioRef,
    TranscriptionRecord,
)
from hornscribe.rhythm import (  # noqa: E402
    assemble_score_document,
    normalize_to_score_time,
    quantize_events,
)

OUT = Path(__file__).resolve().parent.parent / "fixtures"


def _write_json(path: Path, data: object) -> None:
    # newline="\n" keeps committed fixtures LF-only on every platform.
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    project_id = derive_project_id({"fixture": "minimal_v1", "created": "2026-09-22"})
    tr_rev: TranscriptionRevisionId = derive_transcription_revision_id(
        {"backend": "fixture", "audioHash": "0" * 64, "settings": {}}
    )
    raw_alloc = IdAllocator("rne")
    raw_alloc.allocate()  # rne-000001 — raw event that produced sn-000001

    score_alloc = IdAllocator("sn")
    note = QuantizedNote(
        id=ScoreNoteId(score_alloc.allocate()),
        source_event_ids=(RawNoteEventId("rne-000001"),),
        pitch_midi=60,  # Concert C4
        start_beat=Fraction(0),
        duration_beats=Fraction(1),
        velocity=80,
    )
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="part-1", name="Horn in F", notes=(note,)),),
        quantization_settings={"grid": "1/16", "triplets": False},
    )
    score = ScoreDocument(project_id=project_id, payload=payload, title="Fixture")

    project = HornScribeProject(
        schema_version=SCHEMA_VERSION,
        project_id=project_id,
        source_audio=SourceAudioRef(original_path="fixtures/audio/c4.wav", content_hash="0" * 64),
        transcription=TranscriptionRecord(
            backend="fixture",
            backend_version="0.0.0",
            settings={},
            revision=tr_rev,
            raw_result_ref="cache/fixture/transcription.json",
        ),
        score=ScoreRef(
            revision=score.revision,
            score_ref="cache/fixture/score.json",
            quantization_settings=payload.quantization_settings,
        ),
    )

    (OUT / "project").mkdir(parents=True, exist_ok=True)
    project_path = OUT / "project" / "minimal_v1.hornscribe.json"
    _write_json(project_path, project.to_dict())
    score_path = OUT / "score" / "minimal_v1.score.json"
    score_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(score_path, score.to_dict())
    print(f"wrote {project_path.relative_to(OUT.parent)} and {score_path.relative_to(OUT.parent)}")

    golden = _golden_score(project_id)
    golden_path = OUT / "score" / "golden_v1.score.json"
    _write_json(golden_path, golden.to_dict())
    print(f"wrote {golden_path.relative_to(OUT.parent)}")

    _write_musicxml_fixtures("minimal_v1", score)
    _write_musicxml_fixtures("golden_v1", golden)

    # QNT-004 meter goldens: quantized fixture output lifted to canonical
    # scores, then exported (issue #18 MusicXML round-trip acceptance).
    for make in rhythm_fixtures.METER_GOLDEN_FACTORIES:
        fixture = make()
        assert fixture.meter_map is not None
        alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
        notes = normalize_to_score_time(fixture.events, fixture.warp)
        doc = assemble_score_document(
            alt,
            notes,
            fixture.meter_map,
            bpm=fixture.bpm or 120.0,
            title=fixture.name,
        )
        _write_musicxml_fixtures(fixture.name, doc)


def _golden_score(project_id) -> ScoreDocument:
    """Small deterministic score exercising ties, rests, and barline splits.

    4/4, C major, 100 bpm. sn-000003 crosses the barline and its measure-2
    fragment has a complex duration, so music21 splits it further — the
    fixture therefore demonstrates hs-sn-*-k fragment IDs as well.
    """
    alloc = IdAllocator("sn")

    def qn(pitch: int, start: str, dur: str) -> QuantizedNote:
        return QuantizedNote(
            id=ScoreNoteId(alloc.allocate()),
            source_event_ids=(),
            pitch_midi=pitch,
            start_beat=Fraction(start),
            duration_beats=Fraction(dur),
            velocity=80,
        )

    notes = (
        qn(60, "0", "1"),  # concert C4  -> written G4
        qn(66, "1", "3/2"),  # concert F#4 -> written C#5 (dotted quarter)
        qn(58, "5/2", "4"),  # concert Bb3 -> written F4, crosses barline
        qn(64, "8", "2"),  # concert E4  -> written B4
    )
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=100.0),),
        time_signature=TimeSignature(beats_per_measure=4, beat_unit=4),
        key_signature=KeySignature(fifths=0, mode="major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="part-1", name="Horn in F", notes=notes),),
        quantization_settings={"grid": "1/16", "triplets": False},
    )
    return ScoreDocument(project_id=project_id, payload=payload, title="Golden Fixture")


def _write_musicxml_fixtures(basename: str, score: ScoreDocument) -> None:
    out_dir = OUT / "musicxml"
    out_dir.mkdir(parents=True, exist_ok=True)
    concert_path = out_dir / export_filename("concert", basename)
    horn_path = out_dir / export_filename("horn_in_f", basename)
    concert_path.write_text(export_concert_musicxml(score), encoding="utf-8", newline="\n")
    horn_path.write_text(export_horn_in_f_musicxml(score), encoding="utf-8", newline="\n")
    print(f"wrote {concert_path.relative_to(OUT.parent)} and {horn_path.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main()
