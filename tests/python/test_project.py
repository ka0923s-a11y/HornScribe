"""FND-001: project schema v1 round-trip, validation, store, migration."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from hornscribe.domain.ids import ProjectId, ScoreNoteId, ScoreRevisionId, TranscriptionRevisionId
from hornscribe.project.errors import (
    ProjectValidationError,
    SchemaVersionError,
    SourceAudioHashMismatchError,
    SourceAudioMissingError,
)
from hornscribe.project.migrate import migrate_project_dict
from hornscribe.project.model import (
    SCHEMA_VERSION,
    HornScribeProject,
    ReviewDecision,
    ScoreRef,
    SourceAudioRef,
    TranscriptionRecord,
    UserEdit,
)
from hornscribe.project.store import ProjectStore

FIXTURE = (
    Path(__file__).resolve().parents[2] / "fixtures" / "project" / "minimal_v1.hornscribe.json"
)


def _sample() -> HornScribeProject:
    return HornScribeProject(
        schema_version=SCHEMA_VERSION,
        project_id=ProjectId("prj-" + "1" * 16),
        source_audio=SourceAudioRef(original_path="/audio/a.wav", content_hash="a" * 64),
        transcription=TranscriptionRecord(
            backend="basic_pitch",
            backend_version="0.4.0",
            settings={"onset": 0.5},
            revision=TranscriptionRevisionId("tr-" + "2" * 16),
            raw_result_ref="cache/x/raw.json",
        ),
        score=ScoreRef(
            revision=ScoreRevisionId("rev-" + "3" * 16),
            score_ref="cache/x/score.json",
            quantization_settings={"grid": "1/16"},
        ),
        user_edits=(
            UserEdit(
                id="edit-1",
                score_revision=ScoreRevisionId("rev-" + "3" * 16),
                kind="pitch_change",
                target_note_ids=(ScoreNoteId("sn-000001"),),
                payload={"to": 62},
            ),
        ),
        review_decisions=(
            ReviewDecision(
                issue_id="issue-1",
                score_revision=ScoreRevisionId("rev-" + "3" * 16),
                status="accepted",
            ),
        ),
    )


def test_round_trip_serialization(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    path = tmp_path / "song.hornscribe.json"
    project = _sample()
    store.save(project, path)
    loaded = store.load(path)
    assert loaded == project
    assert loaded.to_dict() == project.to_dict()


def test_committed_fixture_loads() -> None:
    from hornscribe.domain.ids import is_project_id

    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    project = HornScribeProject.from_dict(data)
    assert project.schema_version == SCHEMA_VERSION
    assert is_project_id(str(project.project_id))


def test_fixture_json_schema_shape() -> None:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(data) == {
        "schemaVersion",
        "projectId",
        "sourceAudio",
        "transcription",
        "score",
        "userEdits",
        "reviewDecisions",
        "uiSession",
    }


def test_missing_schema_version_fails_safely() -> None:
    with pytest.raises(SchemaVersionError):
        HornScribeProject.from_dict({"projectId": "prj-" + "1" * 16})


def test_unknown_future_version_fails_safely() -> None:
    with pytest.raises(SchemaVersionError, match="unsupported schemaVersion 99"):
        HornScribeProject.from_dict({"schemaVersion": 99, "projectId": "prj-" + "1" * 16})


def test_non_integer_version_fails_safely() -> None:
    with pytest.raises(SchemaVersionError):
        HornScribeProject.from_dict({"schemaVersion": "1", "projectId": "prj-" + "1" * 16})


def test_malformed_project_id_rejected() -> None:
    with pytest.raises(ProjectValidationError):
        HornScribeProject.from_dict({"schemaVersion": 1, "projectId": "nope"})


def test_malformed_score_revision_rejected() -> None:
    bad = _sample().to_dict()
    bad["score"]["revision"] = "bad"
    with pytest.raises(ProjectValidationError):
        HornScribeProject.from_dict(bad)


def test_malformed_edit_note_id_rejected() -> None:
    bad = _sample().to_dict()
    bad["userEdits"][0]["targetNoteIds"] = ["rne-000001"]
    with pytest.raises(ProjectValidationError):
        HornScribeProject.from_dict(bad)


def test_atomic_write_leaves_no_tmp(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    path = tmp_path / "p.hornscribe.json"
    store.save(_sample(), path)
    assert path.exists()
    assert not (tmp_path / "p.hornscribe.json.tmp").exists()


def test_recovery_snapshot_keeps_previous_good(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    path = tmp_path / "p.hornscribe.json"
    store.save(_sample(), path)
    v2 = _sample().to_dict()
    v2["uiSession"] = {"window": "score"}
    path.write_text(json.dumps(v2), encoding="utf-8")
    store.save(_sample(), path)
    recovery = path.with_name(path.name + ".recovery")
    assert recovery.exists()
    assert json.loads(recovery.read_text(encoding="utf-8"))["uiSession"] == {"window": "score"}


def test_load_falls_back_to_recovery(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    path = tmp_path / "p.hornscribe.json"
    store.save(_sample(), path)
    # simulate crash: corrupt main file, recovery holds last good
    good = path.read_bytes()
    path.with_name(path.name + ".recovery").write_bytes(good)
    path.write_bytes(b"{corrupt")
    loaded = store.load(path)
    assert loaded == _sample()


def test_relink_source_audio_by_hash(tmp_path: Path) -> None:
    audio = tmp_path / "moved.wav"
    audio.write_bytes(b"fake-audio")
    import hashlib

    project = _sample()
    project = HornScribeProject(
        schema_version=project.schema_version,
        project_id=project.project_id,
        source_audio=SourceAudioRef(
            original_path=str(tmp_path / "old.wav"),
            content_hash=hashlib.sha256(b"fake-audio").hexdigest(),
        ),
    )
    store = ProjectStore(tmp_path)
    relinked = store.relink_source_audio(project, audio)
    assert relinked is not None
    assert relinked.source_audio is not None
    assert relinked.source_audio.original_path == str(audio)


def test_relink_rejects_hash_mismatch(tmp_path: Path) -> None:
    audio = tmp_path / "other.wav"
    audio.write_bytes(b"different")
    store = ProjectStore(tmp_path)
    with pytest.raises(SourceAudioHashMismatchError):
        store.relink_source_audio(_sample(), audio)


def test_verify_source_audio_missing(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = _sample()
    with pytest.raises(SourceAudioMissingError):
        store.verify_source_audio(project)


def test_migration_identity_v1() -> None:
    data = _sample().to_dict()
    assert migrate_project_dict(data) == data


def test_migration_future_version_fails() -> None:
    with pytest.raises(SchemaVersionError, match="newer than supported"):
        migrate_project_dict({"schemaVersion": 7})


def test_atomic_write_survives_replace(tmp_path: Path) -> None:
    """os.replace is atomic on the same volume; file never half-written."""
    store = ProjectStore(tmp_path)
    path = tmp_path / "p.hornscribe.json"
    store.save(_sample(), path)
    store.save(_sample(), path)
    assert os.path.getsize(path) > 0


def test_saved_project_keys_match_published_schema() -> None:
    """#255: every root key a v1 project can carry is declared in
    protocol/schema/project-v1.schema.json — the published contract must
    not reject documents HornScribe itself writes."""
    schema = json.loads(
        (Path(__file__).resolve().parents[2]
         / "protocol" / "schema" / "project-v1.schema.json").read_text(
            encoding="utf-8"
        )
    )
    declared = set(schema["properties"])
    saved = _sample().to_dict()
    # The desktop writes these extras too (#218); both model output and
    # the desktop's extras must be schema-declared.
    saved.update(
        {
            "scoreDocument": None,
            "reviewIssues": [],
            "musicXmlConcert": None,
            "musicXmlHornF": None,
            "meta": None,
        }
    )
    undeclared = set(saved) - declared
    assert not undeclared, f"saved keys missing from schema: {undeclared}"
