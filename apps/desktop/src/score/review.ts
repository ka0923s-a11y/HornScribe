/**
 * Review-issue model — TypeScript mirror of
 * `python/hornscribe/domain/review.py` (MASTER_PLAN §10).
 *
 * The engine converts backend-specific evidence into product-level review
 * items; the UI consumes the reason code and maps it to Japanese copy — it
 * never interprets raw backend confidence as a universal probability.
 */

/** Engine-side reason codes (stable API; keep in sync with ReviewReason). */
export type ReviewReason =
  | "low_model_confidence"
  | "very_short_detection"
  | "overlapping_candidates"
  | "quantization_ambiguous"
  | "pitch_spelling_ambiguous"
  | "outside_preferred_horn_range"
  | "structural_measure_conflict";

export type ReviewSeverity = "info" | "caution" | "warning";
export type ReviewIssueStatus = "open" | "accepted" | "dismissed" | "fixed";

export interface ScoreReviewIssue {
  /** `ri-<6 digits>`, allocated deterministically within one score revision. */
  readonly id: string;
  readonly scoreRevision: string;
  /** Canonical `sn-*` ids this issue points at (1+). */
  readonly canonicalNoteIds: readonly string[];
  readonly timeRange?: { readonly startSec: number; readonly endSec: number };
  readonly reason: ReviewReason;
  readonly severity: ReviewSeverity;
  /** Engine evidence payload (e.g. `{ confidence: 0.62 }`); never shown raw. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly status: ReviewIssueStatus;
}

/** Issues still needing user attention. */
export function openIssues(issues: readonly ScoreReviewIssue[]): ScoreReviewIssue[] {
  return issues.filter((i) => i.status === "open");
}

/** All open issues touching `canonicalId` (a note can carry several). */
export function issuesForCanonical(
  issues: readonly ScoreReviewIssue[],
  canonicalId: string,
): ScoreReviewIssue[] {
  return issues.filter(
    (i) => i.status === "open" && i.canonicalNoteIds.includes(canonicalId),
  );
}

/** Canonical ids carrying at least one open issue — drives score markers. */
export function markedCanonicalIds(issues: readonly ScoreReviewIssue[]): Set<string> {
  const out = new Set<string>();
  for (const issue of openIssues(issues)) {
    for (const id of issue.canonicalNoteIds) out.add(id);
  }
  return out;
}

/** Optional model confidence from the evidence payload (0..1), or null.
 *  Surfaced in the inspector as evidence only — never as "probability of
 *  being wrong" (GUI_UX_PLAN §21). The engine emits `modelConfidence`
 *  (sidecar ReviewIssue dicts); `confidence` is accepted for older
 *  payloads. */
export function issueConfidence(issue: ScoreReviewIssue): number | null {
  for (const key of ["confidence", "modelConfidence"] as const) {
    const value = issue.evidence[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
