"""ReviewIssue contract (MASTER_PLAN §10).

The engine converts backend-specific evidence into product-level review
items. The UI consumes these — it never interprets raw backend confidence
as a universal probability.

Accepting/dismissing an issue never deletes raw evidence; decisions are
persisted against ``(issue_id, score_revision)`` in the project file
(:class:`~hornscribe.project.model.ReviewDecision`). Re-quantization or
re-transcription produces a new ``score_revision`` — issues from an older
revision are invalidated or explicitly remapped, never silently carried.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from hornscribe.domain.ids import ScoreNoteId, ScoreRevisionId


class ReviewReason(Enum):
    """Engine-side reason codes (stable API; UI maps them to Japanese copy)."""

    LOW_MODEL_CONFIDENCE = "low_model_confidence"
    VERY_SHORT_DETECTION = "very_short_detection"
    OVERLAPPING_CANDIDATES = "overlapping_candidates"
    QUANTIZATION_AMBIGUOUS = "quantization_ambiguous"
    POSSIBLE_TRIPLET = "possible_triplet"
    PITCH_SPELLING_AMBIGUOUS = "pitch_spelling_ambiguous"
    OUTSIDE_PREFERRED_HORN_RANGE = "outside_preferred_horn_range"
    STRUCTURAL_MEASURE_CONFLICT = "structural_measure_conflict"
    # Auto-meter estimation could not justify its pick — the UI copy
    # deck already carries `meter_conflict` for this surface.
    METER_CONFLICT = "meter_conflict"
    # #134: offbeat onsets cluster at the triplet's third position —
    # the piece is probably swung, but the notation wrote straight
    # eighths or triplets.
    SWING_FEEL = "swing_feel"
    # #181: the job ran a monophonic backend (pYIN) under a texture
    # that may carry polyphony — any second voice is silently absent
    # from the result.
    MONOPHONIC_BACKEND = "monophonic_backend"
    # #188: the auto-estimated tempo looks like a half/double pick —
    # evidence carries a suggested correction the UI can one-click.
    TEMPO_UNCERTAIN = "tempo_uncertain"
    # #187: the opt-in vocal-isolation stage ran — the backend saw a
    # center-extracted vocal estimate, not the raw mix (informational).
    VOCAL_ISOLATION_APPLIED = "vocal_isolation_applied"
    # #187: vocal isolation was requested but did not apply — mono
    # source or a failed decode; the backend ran on the raw audio.
    # #322: also emitted when a voices/chords texture skipped
    # isolation — stripping the accompaniment would defeat the
    # multi-voice request (evidence.detail = "polyphonic_texture").
    VOCAL_ISOLATION_UNAVAILABLE = "vocal_isolation_unavailable"
    # #352: the auto-estimated key could not be justified — low
    # absolute correlation, a runner-up that explains the notes almost
    # as well (relative major/minor pairs land here), too little
    # material, or an ambiguous mid-piece segment. Evidence carries the
    # estimate, runner-up + margin, and per-segment stats when the
    # piece modulates — the remedy is the properties key editor.
    KEY_UNCERTAIN = "key_uncertain"


class Severity(Enum):
    """Review severity — UI must not encode this by color alone."""

    INFO = "info"
    CAUTION = "caution"
    WARNING = "warning"


class IssueStatus(Enum):
    OPEN = "open"
    ACCEPTED = "accepted"
    DISMISSED = "dismissed"
    FIXED = "fixed"


@dataclass(frozen=True)
class TimeRange:
    start_sec: float
    end_sec: float

    def to_dict(self) -> dict[str, Any]:
        return {"startSec": self.start_sec, "endSec": self.end_sec}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TimeRange:
        return cls(start_sec=float(data["startSec"]), end_sec=float(data["endSec"]))


@dataclass(frozen=True)
class ReviewIssue:
    """A reviewable artifact of the transcription/quantization pipeline."""

    id: str
    score_revision: ScoreRevisionId
    canonical_note_ids: tuple[ScoreNoteId, ...]
    time_range: TimeRange
    reason: ReviewReason
    severity: Severity
    evidence: dict[str, Any] = field(default_factory=dict)
    status: IssueStatus = IssueStatus.OPEN

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "scoreRevision": str(self.score_revision),
            "canonicalNoteIds": [str(n) for n in self.canonical_note_ids],
            "timeRange": self.time_range.to_dict(),
            "reason": self.reason.value,
            "severity": self.severity.value,
            "evidence": self.evidence,
            "status": self.status.value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ReviewIssue:
        return cls(
            id=str(data["id"]),
            score_revision=ScoreRevisionId(data["scoreRevision"]),
            canonical_note_ids=tuple(
                ScoreNoteId(n) for n in data.get("canonicalNoteIds", ())
            ),
            time_range=TimeRange.from_dict(data["timeRange"]),
            reason=ReviewReason(data["reason"]),
            severity=Severity(data["severity"]),
            evidence=dict(data.get("evidence", {})),
            status=IssueStatus(data.get("status", "open")),
        )


class IssueIdAllocator:
    """Deterministic issue IDs within one score revision: ``ri-000001``."""

    def __init__(self) -> None:
        self._next = 1

    def allocate(self) -> str:
        value = f"ri-{self._next:06d}"
        self._next += 1
        return value
