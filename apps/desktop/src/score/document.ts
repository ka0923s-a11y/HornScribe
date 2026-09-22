/**
 * ScoreDocumentPort — the typed seam between the score workspace and the
 * score source (UI-030).
 *
 * Today the only implementation is the deterministic fixture adapter
 * (`fixtureDocument.ts`). When the engine pipeline lands (UI-040+), a real
 * adapter supplies the same shape — canonical MusicXML per presentation,
 * review issues, document meta — and the workspace needs no changes.
 *
 * Contract notes (FND-001 / ids.py):
 * - `musicXml("concert")` is the canonical sounding document;
 *   `musicXml("hornF")` is the written-pitch F管 presentation of the SAME
 *   canonical notes — identical `hs-sn-*` element ids in both.
 * - `reviewIssues()` mirrors `ReviewIssue.to_dict()` (domain/review.py).
 */
import type { PitchViewSetting } from "../commands/types";
import type { ReviewIssueStatus, ScoreReviewIssue } from "./review";
import type { ScoreNoteEdit } from "./scoreEdits";

export interface ScoreDocumentMeta {
  /** Document title (MusicXML movement/work title). */
  readonly title: string;
  /** Tempo from `<sound tempo>` / score tempo map, beats per minute. */
  readonly tempoBpm: number | null;
  /** Time signature "4/4" style, when notated. */
  readonly meter: string | null;
  /** Key signature fifths (−7…+7), when notated. */
  readonly keyFifths: number | null;
  /** Number of measures in the score. */
  readonly measureCount: number;
  /** Number of canonical `sn-*` notes (rests excluded). */
  readonly noteCount: number;
}

export interface ScoreDocumentPort {
  /** `rev-<sha256[:16]>` — content-derived score revision id. A new
   *  transcription/quantization produces a new revision; review decisions
   *  and note edits are bound to it and never silently carried across
   *  (domain/review.py contract). */
  readonly revisionId: string;
  /** Bumped on every user edit/decision so views can invalidate. */
  readonly editVersion: number;
  readonly meta: ScoreDocumentMeta;
  /** MusicXML 4.0 string for the given pitch presentation — includes any
   *  user note edits (UI-050), so export sees the corrected document. */
  musicXml(view: PitchViewSetting): string;
  /** Review issues for this score revision (any status), with user
   *  decisions recorded via `recordReviewDecision` already applied. */
  reviewIssues(): readonly ScoreReviewIssue[];
  /**
   * Persist a review decision against (issueId, this revision) — the
   * document-model record the project-file adapter will later serialize.
   */
  recordReviewDecision(issueId: string, status: ReviewIssueStatus): void;
  /** Current canonical-note edits (`sn-*` id → edit). */
  noteEdits(): ReadonlyMap<string, ScoreNoteEdit>;
  /** Set or clear (`null` / empty edit) a canonical note's correction. */
  setNoteEdit(canonicalId: string, edit: ScoreNoteEdit | null): void;
}
