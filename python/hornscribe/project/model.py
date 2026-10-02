"""HornScribe project schema v1 (FND-001).

A ``.hornscribe.json`` project file is the authoritative persisted state.
Cache files are rebuildable and never authoritative.

Authoritative vs derived
------------------------
* Authoritative: source audio reference + hash, transcription record,
  canonical score document, quantization settings, user edits, review
  decisions.
* Derived/rebuildable: normalized WAV, rendered previews, exported files,
  search indexes — all live in the cache directory and are excluded.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hornscribe.domain.ids import (
    ProjectId,
    ScoreNoteId,
    ScoreRevisionId,
    TranscriptionRevisionId,
    is_project_id,
    is_score_note_id,
    is_score_revision_id,
    is_transcription_revision_id,
)
from hornscribe.project.errors import ProjectValidationError, SchemaVersionError

SCHEMA_VERSION = 1
PROJECT_FILE_SUFFIX = ".hornscribe.json"


def hash_file_sha256(path: Path) -> str:
    """Streaming SHA-256 of file contents (source audio content hash)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class SourceAudioRef:
    """Reference to user-owned audio. The file itself is never modified."""

    original_path: str
    content_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {"originalPath": self.original_path, "contentHash": self.content_hash}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SourceAudioRef:
        return cls(
            original_path=str(data["originalPath"]),
            content_hash=str(data["contentHash"]),
        )

    @classmethod
    def for_file(cls, path: Path) -> SourceAudioRef:
        return cls(original_path=str(path), content_hash=hash_file_sha256(path))


@dataclass(frozen=True)
class TranscriptionRecord:
    """Provenance of a raw transcription result."""

    backend: str
    backend_version: str
    settings: dict[str, Any]
    revision: TranscriptionRevisionId
    # #223: legacy cache-relative path to a raw JSON artifact. Optional
    # — evidence now travels inline on the scoreDocument (rawEvidence),
    # and older writers emitted this ref without ever creating the file.
    raw_result_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out = {
            "backend": self.backend,
            "backendVersion": self.backend_version,
            "settings": self.settings,
            "revision": str(self.revision),
        }
        if self.raw_result_ref is not None:
            out["rawResultRef"] = self.raw_result_ref
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TranscriptionRecord:
        return cls(
            backend=str(data["backend"]),
            backend_version=str(data["backendVersion"]),
            settings=dict(data.get("settings", {})),
            revision=TranscriptionRevisionId(data["revision"]),
            raw_result_ref=(
                str(data["rawResultRef"])
                if data.get("rawResultRef") is not None
                else None
            ),
        )


@dataclass(frozen=True)
class ScoreRef:
    """Pointer to the active canonical score revision."""

    revision: ScoreRevisionId
    quantization_settings: dict[str, Any]
    # #223: legacy cache-relative path — optional, same rationale as
    # TranscriptionRecord.raw_result_ref (inline document is canonical).
    score_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out = {
            "revision": str(self.revision),
            "quantizationSettings": self.quantization_settings,
        }
        if self.score_ref is not None:
            out["scoreRef"] = self.score_ref
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreRef:
        return cls(
            revision=ScoreRevisionId(data["revision"]),
            quantization_settings=dict(data.get("quantizationSettings", {})),
            score_ref=(
                str(data["scoreRef"])
                if data.get("scoreRef") is not None
                else None
            ),
        )


@dataclass(frozen=True)
class UserEdit:
    """A user-authored correction bound to canonical note IDs."""

    id: str
    score_revision: ScoreRevisionId
    kind: str  # e.g. pitch_change, delete, restore, split, merge
    target_note_ids: tuple[ScoreNoteId, ...]
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "scoreRevision": str(self.score_revision),
            "kind": self.kind,
            "targetNoteIds": [str(n) for n in self.target_note_ids],
            "payload": self.payload,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UserEdit:
        return cls(
            id=str(data["id"]),
            score_revision=ScoreRevisionId(data["scoreRevision"]),
            kind=str(data["kind"]),
            target_note_ids=tuple(ScoreNoteId(n) for n in data.get("targetNoteIds", ())),
            payload=dict(data.get("payload", {})),
        )


@dataclass(frozen=True)
class ReviewDecision:
    """A persisted decision on an engine-generated ReviewIssue."""

    issue_id: str
    score_revision: ScoreRevisionId
    status: str  # accepted | dismissed | fixed
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "issueId": self.issue_id,
            "scoreRevision": str(self.score_revision),
            "status": self.status,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ReviewDecision:
        return cls(
            issue_id=str(data["issueId"]),
            score_revision=ScoreRevisionId(data["scoreRevision"]),
            status=str(data["status"]),
            note=data.get("note"),
        )


#: Keys the schema v1 model owns — everything else in a project document
#: is a preserved extra (#218: scoreDocument/musicXml/reviewIssues/meta
#: must survive the save round-trip, or reopened projects lose the score).
_SCHEMA_KEYS = frozenset({
    "schemaVersion",
    "projectId",
    "sourceAudio",
    "transcription",
    "score",
    "userEdits",
    "reviewDecisions",
    "uiSession",
})


@dataclass(frozen=True)
class HornScribeProject:
    """Root persisted object for ``schemaVersion`` 1.

    ``extras`` carries keys the schema does not model (the desktop writes
    scoreDocument / musicXmlConcert / musicXmlHornF / musicXmlBFlat /
    reviewIssues / meta
    so a saved project restores its score without re-transcribing —
    #106/#218).  They round-trip verbatim; schema keys always win on a
    name collision so a future field cannot be silently shadowed.
    """

    schema_version: int
    project_id: ProjectId
    source_audio: SourceAudioRef | None = None
    transcription: TranscriptionRecord | None = None
    score: ScoreRef | None = None
    user_edits: tuple[UserEdit, ...] = ()
    review_decisions: tuple[ReviewDecision, ...] = ()
    ui_session: dict[str, Any] | None = None  # optional, non-authoritative
    extras: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = dict(self.extras)
        data.update(
            {
                "schemaVersion": self.schema_version,
                "projectId": str(self.project_id),
                "sourceAudio": self.source_audio.to_dict() if self.source_audio else None,
                "transcription": self.transcription.to_dict() if self.transcription else None,
                "score": self.score.to_dict() if self.score else None,
                "userEdits": [e.to_dict() for e in self.user_edits],
                "reviewDecisions": [d.to_dict() for d in self.review_decisions],
                "uiSession": self.ui_session,
            }
        )
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> HornScribeProject:
        if not isinstance(data, dict):
            raise ProjectValidationError("project document is not an object")
        version = data.get("schemaVersion")
        if version is None:
            raise SchemaVersionError("missing required field: schemaVersion")
        if not isinstance(version, int):
            raise SchemaVersionError(f"schemaVersion must be an integer, got {version!r}")
        if version != SCHEMA_VERSION:
            raise SchemaVersionError(
                f"unsupported schemaVersion {version}; this build supports {SCHEMA_VERSION}"
            )
        project_id = data.get("projectId")
        if not isinstance(project_id, str) or not is_project_id(project_id):
            raise ProjectValidationError("projectId is missing or malformed")
        _validate_ids(data)
        return cls(
            schema_version=version,
            project_id=ProjectId(project_id),
            source_audio=(
                SourceAudioRef.from_dict(data["sourceAudio"]) if data.get("sourceAudio") else None
            ),
            transcription=(
                TranscriptionRecord.from_dict(data["transcription"])
                if data.get("transcription")
                else None
            ),
            score=ScoreRef.from_dict(data["score"]) if data.get("score") else None,
            user_edits=tuple(UserEdit.from_dict(e) for e in data.get("userEdits", ())),
            review_decisions=tuple(
                ReviewDecision.from_dict(d) for d in data.get("reviewDecisions", ())
            ),
            ui_session=data.get("uiSession"),
            extras={k: v for k, v in data.items() if k not in _SCHEMA_KEYS},
        )


def _validate_ids(data: dict[str, Any]) -> None:
    transcription = data.get("transcription")
    if transcription and not is_transcription_revision_id(transcription.get("revision", "")):
        raise ProjectValidationError("transcription.revision is malformed")
    score = data.get("score")
    if score and not is_score_revision_id(score.get("revision", "")):
        raise ProjectValidationError("score.revision is malformed")
    for edit in data.get("userEdits", ()):
        if not is_score_revision_id(edit.get("scoreRevision", "")):
            raise ProjectValidationError("userEdits[].scoreRevision is malformed")
        for note_id in edit.get("targetNoteIds", ()):
            if not is_score_note_id(note_id):
                raise ProjectValidationError("userEdits[].targetNoteIds contains malformed ID")
    for decision in data.get("reviewDecisions", ()):
        if not is_score_revision_id(decision.get("scoreRevision", "")):
            raise ProjectValidationError("reviewDecisions[].scoreRevision is malformed")
