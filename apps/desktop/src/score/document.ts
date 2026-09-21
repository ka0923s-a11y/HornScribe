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
import type { ScoreReviewIssue } from "./review";

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
  /** `rev-<sha256[:16]>` — content-derived score revision id. */
  readonly revisionId: string;
  readonly meta: ScoreDocumentMeta;
  /** MusicXML 4.0 string for the given pitch presentation. */
  musicXml(view: PitchViewSetting): string;
  /** Review issues for this score revision (any status). */
  reviewIssues(): readonly ScoreReviewIssue[];
}
