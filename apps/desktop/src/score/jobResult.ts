/**
 * UI-040 → UI-030 handoff adapter.
 *
 * A completed transcription job carries `result` (`unknown`) with
 * `scoreRevision` and `reviewIssues` (sidecar/protocol.ts). This module
 * normalizes that payload into the typed score-side contract:
 *
 * - `scoreRevision` → the document `revisionId` (remount key / identity).
 * - `reviewIssues` → `ScoreReviewIssue[]` — the same ReviewIssue shape the
 *   python domain emits; reason codes stay verbatim (the copy layer falls
 *   back to `reviewReasons.other` for codes newer than the enum).
 *
 * What the result does NOT carry yet is MusicXML — the engine pipeline
 * still owes the real document body. Until then the fixture adapter
 * supplies the notation and only identity + review issues come from the
 * job result. That is deliberately honest: no fake engraving is claimed
 * to be engine output.
 */
import {
  extractReviewIssues,
  REVIEW_ISSUE_STATUSES,
  REVIEW_SEVERITIES,
  type ReviewIssuePayload,
} from "../sidecar/review";
import type {
  ReviewIssueStatus,
  ReviewReason,
  ReviewSeverity,
  ScoreReviewIssue,
} from "./review";

/** Fields the score document takes from a completed job's result. */
export interface ScoreResultHandoff {
  /** `sr-*` revision id, when the engine emitted one. */
  readonly revisionId?: string;
  /** Review issues typed for the score workspace (possibly empty — a
   *  clean transcription honestly reports zero issues). */
  readonly issues: readonly ScoreReviewIssue[];
}

/**
 * Extract the score-facing fields from `session.lastResult`.
 * Returns `undefined` when the payload is not an object at all (e.g. no
 * result was attached) so callers can fall back to fixture defaults; an
 * object without `reviewIssues` yields an empty issue list — the absence
 * of issues is real information, not a fallback case.
 */
export function scoreHandoffFromResult(
  result: unknown,
): ScoreResultHandoff | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  return {
    revisionId:
      typeof r.scoreRevision === "string" ? r.scoreRevision : undefined,
    issues: extractReviewIssues(result).map(toScoreIssue),
  };
}

function toScoreIssue(p: ReviewIssuePayload): ScoreReviewIssue {
  return {
    id: p.id,
    scoreRevision:
      typeof p.scoreRevision === "string" ? p.scoreRevision : "",
    canonicalNoteIds: Array.isArray(p.canonicalNoteIds)
      ? p.canonicalNoteIds.filter((id): id is string => typeof id === "string")
      : [],
    timeRange: isTimeRange(p.timeRange) ? p.timeRange : undefined,
    // Verbatim reason code — `ja.reviewReasons.other` covers engine codes
    // this UI version does not know yet (same policy as sidecar/review.ts).
    reason: p.reason as ReviewReason,
    severity: isSeverity(p.severity) ? p.severity : "info",
    evidence: p.evidence ?? {},
    status: isStatus(p.status) ? p.status : "open",
  };
}

function isTimeRange(
  raw: unknown,
): raw is { readonly startSec: number; readonly endSec: number } {
  if (typeof raw !== "object" || raw === null) return false;
  const t = raw as Record<string, unknown>;
  return typeof t.startSec === "number" && typeof t.endSec === "number";
}

function isSeverity(raw: unknown): raw is ReviewSeverity {
  return (
    typeof raw === "string" &&
    (REVIEW_SEVERITIES as readonly string[]).includes(raw)
  );
}

function isStatus(raw: unknown): raw is ReviewIssueStatus {
  return (
    typeof raw === "string" &&
    (REVIEW_ISSUE_STATUSES as readonly string[]).includes(raw)
  );
}
