/**
 * Deterministic fixture adapter for `ScoreDocumentPort` (UI-030).
 *
 * MusicXML source: the committed UI-005 sync fixtures — a 12-bar, 4/4,
 * 100 BPM single-part score with 40 canonical `sn-*` notes, three tie
 * chains (incl. a 3-fragment chain) and two rests; the concert and F管
 * documents share identical `hs-sn-*` ids, which is exactly what the
 * Concert↔F管 context-preservation path is verified against.
 *
 * Review issues are fixed (never randomized) so every run renders the same
 * 要確認 markers on the same canonical notes.
 *
 * This file is the seam where engine output slots in (UI-040+): replace
 * `createFixtureScoreDocument()` call sites with a real adapter — nothing
 * downstream changes.
 */
import concertXml from "./fixtures/score_concert.musicxml?raw";
import hornXml from "./fixtures/score_horn_in_f.musicxml?raw";
import type { PitchViewSetting } from "../commands/types";
import type { ScoreDocumentMeta, ScoreDocumentPort } from "./document";
import { parseScoreDoc } from "./scoreDoc";
import type { ReviewIssueStatus, ScoreReviewIssue } from "./review";
import {
  applyNoteEdits,
  isEmptyNoteEdit,
  type ScoreNoteEdit,
} from "./scoreEdits";

/** Deterministic revision id for the bundled fixture document. */
const FIXTURE_REVISION = "rev-fixture0000001";

const FIXTURE_ISSUES: readonly ScoreReviewIssue[] = [
  {
    id: "ri-000001",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000012"],
    timeRange: { startSec: 6.6, endSec: 9.0 },
    reason: "quantization_ambiguous",
    severity: "caution",
    evidence: { confidence: 0.71 },
    status: "open",
  },
  {
    id: "ri-000002",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000022"],
    timeRange: { startSec: 13.2, endSec: 13.8 },
    reason: "low_model_confidence",
    severity: "warning",
    evidence: { confidence: 0.58 },
    status: "open",
  },
  {
    id: "ri-000003",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000034", "sn-000035"],
    timeRange: { startSec: 20.4, endSec: 21.6 },
    reason: "pitch_spelling_ambiguous",
    severity: "caution",
    evidence: {},
    status: "open",
  },
];

/** What a real job result may override on top of the fixture notation
 *  (score/jobResult.ts) — MusicXML itself stays fixture until the engine
 *  ships document bodies. */
export interface FixtureDocumentOverrides {
  /** Completed job's `scoreRevision`, when present. */
  readonly revisionId?: string;
  /** Review issues from the job result — `[]` honestly means "the engine
   *  found nothing to flag" (never fall back to fixture issues then). */
  readonly issues?: readonly ScoreReviewIssue[];
}

class FixtureScoreDocument implements ScoreDocumentPort {
  readonly revisionId: string;
  readonly meta: ScoreDocumentMeta;
  private readonly issues: readonly ScoreReviewIssue[];
  /** UI-050 document model: review decisions and note corrections live on
   *  the document, keyed to `revisionId` — a new score revision (re-
   *  transcription / re-quantization) constructs a fresh document, so
   *  stale decisions are never silently carried across revisions. */
  private readonly decisions = new Map<string, ReviewIssueStatus>();
  private readonly edits = new Map<string, ScoreNoteEdit>();
  private editCounter = 0;

  constructor(overrides?: FixtureDocumentOverrides) {
    const doc = parseScoreDoc(concertXml);
    const canonical = new Set(doc.notes.map((n) => n.canonicalId).filter(Boolean));
    this.revisionId = overrides?.revisionId ?? FIXTURE_REVISION;
    this.issues = overrides?.issues ?? FIXTURE_ISSUES;
    this.meta = {
      title: doc.title,
      tempoBpm: doc.tempoBpm,
      meter: doc.meter,
      keyFifths: doc.keyFifths,
      measureCount: doc.measureCount,
      noteCount: canonical.size,
    };
  }

  get editVersion(): number {
    return this.editCounter;
  }

  musicXml(view: PitchViewSetting): string {
    const base = view === "hornF" ? hornXml : concertXml;
    return applyNoteEdits(base, this.edits);
  }

  reviewIssues(): readonly ScoreReviewIssue[] {
    return this.issues.map((issue) => {
      const decided = this.decisions.get(issue.id);
      return decided !== undefined ? { ...issue, status: decided } : issue;
    });
  }

  recordReviewDecision(issueId: string, status: ReviewIssueStatus): void {
    this.decisions.set(issueId, status);
    this.editCounter += 1;
  }

  noteEdits(): ReadonlyMap<string, ScoreNoteEdit> {
    return this.edits;
  }

  setNoteEdit(canonicalId: string, edit: ScoreNoteEdit | null): void {
    if (edit == null || isEmptyNoteEdit(edit)) this.edits.delete(canonicalId);
    else this.edits.set(canonicalId, edit);
    this.editCounter += 1;
  }
}

/**
 * The deterministic score document used until the engine pipeline delivers
 * real `ScoreDocumentPort` data (UI-040+). Everything derived from it —
 * rendered pages, canonical ids, review markers — is byte-stable.
 *
 * `overrides` carries the UI-040 result handoff (score/jobResult.ts):
 * the job's `scoreRevision` and typed review issues flow through while the
 * notation body remains the committed fixture.
 */
export function createFixtureScoreDocument(
  overrides?: FixtureDocumentOverrides,
): ScoreDocumentPort {
  return new FixtureScoreDocument(overrides);
}
