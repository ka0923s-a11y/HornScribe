"""Regenerate committed fixtures deterministically (run from repo root)."""

from __future__ import annotations

import json
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

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
from hornscribe.project.model import (  # noqa: E402
    SCHEMA_VERSION,
    HornScribeProject,
    ScoreRef,
    SourceAudioRef,
    TranscriptionRecord,
)

OUT = Path(__file__).resolve().parent.parent / "fixtures"


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
    project_path.write_text(
        json.dumps(project.to_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    score_path = OUT / "score" / "minimal_v1.score.json"
    score_path.parent.mkdir(parents=True, exist_ok=True)
    score_path.write_text(
        json.dumps(score.to_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {project_path.relative_to(OUT.parent)} and {score_path.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main()
