/**
 * XmlScoreDocument — `ScoreDocumentPort` over arbitrary MusicXML bodies
 * (ENG-002).
 *
 * The fixture adapter proved the contract; this is the general form the
 * real engine result slots into: the transcription job returns
 * `musicXmlConcert` + `musicXmlHornF` (same canonical `hs-sn-*` ids in
 * both — the export layer's contract), the `sr-*` revision id, and the
 * typed review issues. Review decisions and note edits live here, keyed
 * to `revisionId` — a new score revision constructs a fresh document,
 * so stale decisions are never carried across (domain/review.py rule).
 */
import type { PitchViewSetting } from "../commands/types";
import type { ScoreDocumentMeta, ScoreDocumentPort } from "./document";
import { parseScoreDoc } from "./scoreDoc";
import type { ReviewIssueStatus, ScoreReviewIssue } from "./review";
import {
  applyNoteEdits,
  isEmptyNoteEdit,
  type ScoreNoteEdit,
} from "./scoreEdits";

export interface XmlScoreDocumentSources {
  /** Canonical sounding-pitch MusicXML (`<sound tempo>` etc. drive meta). */
  readonly concertXml: string;
  /** Written-pitch F管 presentation of the SAME canonical notes. */
  readonly hornXml: string;
  /** `sr-*`/`rev-*` revision id the decisions/edits bind to. */
  readonly revisionId: string;
  /** Engine review issues for this revision (`[]` = honestly clean). */
  readonly issues: readonly ScoreReviewIssue[];
  /** #115: canonical scoreDocument dict — the base the engine's
   *  `score.edit` re-realizes from (undefined for fixture/dev). */
  readonly canonicalDocument?: unknown;
}

export class XmlScoreDocument implements ScoreDocumentPort {
  private _revisionId: string;
  private _meta: ScoreDocumentMeta;
  private concertXml: string;
  private hornXml: string;
  private canonicalDoc: unknown | null;
  private readonly issues: readonly ScoreReviewIssue[];
  private readonly decisions = new Map<string, ReviewIssueStatus>();
  private readonly edits = new Map<string, ScoreNoteEdit>();
  private editCounter = 0;

  constructor(src: XmlScoreDocumentSources) {
    this._revisionId = src.revisionId;
    this.issues = src.issues;
    this.concertXml = src.concertXml;
    this.hornXml = src.hornXml;
    this.canonicalDoc = src.canonicalDocument ?? null;
    this._meta = XmlScoreDocument.computeMeta(src.concertXml);
  }

  private static computeMeta(xml: string): ScoreDocumentMeta {
    const doc = parseScoreDoc(xml);
    const canonical = new Set(
      doc.notes.map((n) => n.canonicalId).filter(Boolean),
    );
    return {
      title: doc.title,
      tempoBpm: doc.tempoBpm,
      meter: doc.meter,
      keyFifths: doc.keyFifths,
      keyChanges: doc.keyChanges,
      measureCount: doc.measureCount,
      noteCount: canonical.size,
    };
  }

  get revisionId(): string {
    return this._revisionId;
  }

  get meta(): ScoreDocumentMeta {
    return this._meta;
  }

  get editVersion(): number {
    return this.editCounter;
  }

  musicXml(view: PitchViewSetting): string {
    const base = view === "hornF" ? this.hornXml : this.concertXml;
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

  /* ---- #115: engine rhythm edits swap content in place ---- */

  canonicalDocument(): unknown | null {
    return this.canonicalDoc;
  }

  contentSnapshot() {
    return {
      concertXml: this.concertXml,
      hornXml: this.hornXml,
      revisionId: this._revisionId,
      canonicalDocument: this.canonicalDoc,
    };
  }

  /** Swap XML bodies + revision + canonical payload in place. Meta is
   *  recomputed from the new concert XML (measure/note counts can move).
   *  Note edits and review decisions survive — canonical ids are stable,
   *  and the session's undo stack keeps working across the swap. */
  replaceContent(next: {
    concertXml: string;
    hornXml: string;
    revisionId: string;
    canonicalDocument: unknown;
  }): void {
    this.concertXml = next.concertXml;
    this.hornXml = next.hornXml;
    this._revisionId = next.revisionId;
    this.canonicalDoc = next.canonicalDocument;
    this._meta = XmlScoreDocument.computeMeta(next.concertXml);
    this.editCounter += 1;
  }
}

/** Fields extracted from a completed transcription job's `result`. */
export interface EngineScoreDocumentInput {
  readonly concertXml: string;
  readonly hornXml: string;
  readonly revisionId: string;
  readonly issues: readonly ScoreReviewIssue[];
  /** #115: canonical scoreDocument dict from the job result. */
  readonly canonicalDocument?: unknown;
}

/**
 * Build the score document for a real transcription result. Returns
 * `null` when the payload is not usable (missing/invalid MusicXML) so
 * the caller can fall back honestly instead of mounting a broken score.
 */
export function createEngineScoreDocument(
  input: EngineScoreDocumentInput,
): ScoreDocumentPort | null {
  if (!input.concertXml || !input.hornXml) return null;
  try {
    return new XmlScoreDocument({
      concertXml: input.concertXml,
      hornXml: input.hornXml,
      revisionId: input.revisionId,
      issues: input.issues,
      canonicalDocument: input.canonicalDocument,
    });
  } catch {
    // parseScoreDoc throws on malformed MusicXML — a corrupt engine
    // payload must not take down the workspace.
    return null;
  }
}

/**
 * Extract the document input from `session.lastResult` (the completed
 * job's `result` payload). Returns `null` when the result carries no
 * MusicXML — e.g. the mock port's stand-in result — so callers fall
 * back to the fixture document in dev sessions.
 */
export function engineDocumentFromResult(
  result: unknown,
): EngineScoreDocumentInput | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const concert = r.musicXmlConcert;
  const horn = r.musicXmlHornF;
  if (typeof concert !== "string" || typeof horn !== "string") return null;
  return {
    concertXml: concert,
    hornXml: horn,
    revisionId:
      typeof r.scoreRevision === "string" ? r.scoreRevision : "rev-engine",
    issues: [],
    canonicalDocument:
      typeof r.scoreDocument === "object" && r.scoreDocument !== null
        ? r.scoreDocument
        : undefined,
  };
}
