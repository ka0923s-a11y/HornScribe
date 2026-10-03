/**
 * TypeScript mirror of the engine's ReviewIssue contract
 * (python/hornscribe/domain/review.py, MASTER_PLAN §10).
 *
 * The UI consumes product-level review items — it never interprets raw
 * backend confidence. `reason` maps onto `review.reasons.<reason>` in the
 * copy deck; unknown future reasons fall back to `review.reasons.other`
 * (UI_COPY_CONTRACT §4). The deck knows more reasons than the current
 * engine enum — that is fine (additive), the fallback covers the rest.
 */

/** Engine-side reason codes — mirrors `ReviewReason` in review.py. */
export const REVIEW_REASONS = [
  "low_model_confidence",
  "very_short_detection",
  "overlapping_candidates",
  "quantization_ambiguous",
  "pitch_spelling_ambiguous",
  "outside_preferred_horn_range",
  "structural_measure_conflict",
  "meter_conflict",
  "swing_feel",
  "monophonic_backend",
  // #187: vocal-isolation provenance — applied or reported unavailable.
  "vocal_isolation_applied",
  "vocal_isolation_unavailable",
  // #358: auto-estimated anacrusis the evidence cannot justify.
  "pickup_uncertain",
  // #423: audio-evidence boundary re-scoring (merge/split/uncertain).
  "boundary_uncertain",
  // #419: chord-segment confidence from the local chord map.
  "chord_uncertain",
  // #191: isolated estimate is only a fraction of the source's
  // energy — the melody was buried and notes may be missing.
  "low_lead_level",
] as const;

export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Copy-deck reason keys (`review.reasons.*` in protocol/copy/ja-JP.json).
 *  A superset of the engine enum — newer decks may carry reasons the
 *  engine does not emit yet. */
export const REVIEW_REASON_COPY_KEYS = [
  "low_model_confidence",
  "very_short_detection",
  "overlapping_candidates",
  "quantization_ambiguous",
  "pitch_spelling_ambiguous",
  "outside_preferred_horn_range",
  "structural_measure_conflict",
  "beat_alignment_uncertain",
  "beat_map_uncertain",
  "possible_triplet",
  "possible_grace_note",
  "offset_ambiguous",
  "pickup_ambiguous",
  "meter_conflict",
  "swing_feel",
  "monophonic_backend",
  "tempo_uncertain",
  "vocal_isolation_applied",
  "vocal_isolation_unavailable",
  "key_uncertain",
  "pickup_uncertain",
  "boundary_uncertain",
  "chord_uncertain",
  "onset_uncertain",
  "pitch_uncertain",
  "multiple_candidates",
  "low_lead_level",
  "other",
] as const;

export type ReviewReasonCopyKey = (typeof REVIEW_REASON_COPY_KEYS)[number];

/** Copy-deck key for a reason code — `other` for anything unknown. */
export function reviewReasonCopyKey(reason: string): ReviewReasonCopyKey {
  return (REVIEW_REASON_COPY_KEYS as readonly string[]).includes(reason)
    ? (reason as ReviewReasonCopyKey)
    : "other";
}

export const REVIEW_SEVERITIES = ["info", "caution", "warning"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_ISSUE_STATUSES = [
  "open",
  "accepted",
  "dismissed",
  "fixed",
] as const;
export type ReviewIssueStatus = (typeof REVIEW_ISSUE_STATUSES)[number];

/** `ReviewIssue.to_dict()` shape — camelCase per the project schema. */
export interface ReviewIssuePayload {
  id: string;
  scoreRevision: string;
  canonicalNoteIds: string[];
  timeRange: { startSec: number; endSec: number };
  reason: string;
  severity: string;
  evidence: Record<string, unknown>;
  status: string;
  [key: string]: unknown;
}

export function isReviewIssuePayload(raw: unknown): raw is ReviewIssuePayload {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.reason === "string";
}

/**
 * Open (unresolved) review issues carried by a completed job's
 * `result.reviewIssues` field. The contract consumed here is the handoff
 * point documented for UI-030's score-data adapter: UI-040 only needs the
 * count for the command bar / review gate, so unknown entries count as
 * issues rather than being silently dropped.
 */
export function extractReviewIssues(result: unknown): ReviewIssuePayload[] {
  if (typeof result !== "object" || result === null) return [];
  const raw = (result as Record<string, unknown>).reviewIssues;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isReviewIssuePayload);
}

/** #360: `result.omittedReviewIssues` — the cap-truncated tail the
 *  engine now retains verbatim. Same payload shape as reviewIssues;
 *  absent/invalid → empty list (older engines simply lack the field). */
export function extractOmittedReviewIssues(
  result: unknown,
): ReviewIssuePayload[] {
  if (typeof result !== "object" || result === null) return [];
  const raw = (result as Record<string, unknown>).omittedReviewIssues;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isReviewIssuePayload);
}

/** `result.reviewIssues.length`, with `result.reviewIssueCount` as a
 *  compact alternative the engine may emit instead of the full list. */
export function extractReviewIssueCount(result: unknown): number {
  const issues = extractReviewIssues(result);
  if (issues.length > 0) return issues.length;
  if (typeof result !== "object" || result === null) return 0;
  const raw = (result as Record<string, unknown>).reviewIssueCount;
  return typeof raw === "number" && raw > 0 ? Math.floor(raw) : 0;
}
