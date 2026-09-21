"""ReviewIssue contract tests (MASTER_PLAN §10)."""

from __future__ import annotations

import pytest

from hornscribe.domain.ids import ScoreNoteId, ScoreRevisionId
from hornscribe.domain.review import (
    IssueIdAllocator,
    IssueStatus,
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)


def _issue() -> ReviewIssue:
    return ReviewIssue(
        id="ri-000001",
        score_revision=ScoreRevisionId("rev-" + "a" * 16),
        canonical_note_ids=(ScoreNoteId("sn-000001"), ScoreNoteId("sn-000002")),
        time_range=TimeRange(1.25, 2.0),
        reason=ReviewReason.QUANTIZATION_AMBIGUOUS,
        severity=Severity.CAUTION,
        evidence={"topKDelta": 0.03, "rawConfidence": 0.41},
    )


def test_round_trip() -> None:
    issue = _issue()
    assert ReviewIssue.from_dict(issue.to_dict()) == issue


def test_all_master_plan_reasons_exist() -> None:
    expected = {
        "low_model_confidence",
        "very_short_detection",
        "overlapping_candidates",
        "quantization_ambiguous",
        "pitch_spelling_ambiguous",
        "outside_preferred_horn_range",
        "structural_measure_conflict",
    }
    assert {r.value for r in ReviewReason} == expected


def test_evidence_is_data_not_verdict() -> None:
    issue = _issue()
    assert issue.evidence["rawConfidence"] == 0.41


def test_status_defaults_open_and_decision_is_external() -> None:
    issue = _issue()
    assert issue.status is IssueStatus.OPEN


def test_issue_ids_deterministic() -> None:
    alloc = IssueIdAllocator()
    assert alloc.allocate() == "ri-000001"
    assert alloc.allocate() == "ri-000002"


def test_bad_reason_rejected() -> None:
    with pytest.raises(ValueError):
        ReviewReason("made_up_reason")
