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
 *   `musicXml("bFlat")` is the B♭ written presentation (#156) -
 *   canonical notes — identical `hs-sn-*` element ids in both.
 * - `reviewIssues()` mirrors `ReviewIssue.to_dict()` (domain/review.py).
 */
import type { PitchViewSetting } from "../commands/types";
import type { ReviewIssueStatus, ScoreReviewIssue } from "./review";
import type { ScoreNoteEdit } from "./scoreEdits";
import type { KeyMode } from "./scoreDoc";

export interface ScoreDocumentMeta {
  /** Document title (MusicXML movement/work title). */
  readonly title: string;
  /** #271: notation metadata — <creator type="composer">, null when none. */
  readonly composer: string | null;
  /** #271: notation metadata — <creator type="arranger">, null when none. */
  readonly arranger: string | null;
  /** Tempo from `<sound tempo>` / score tempo map, beats per minute. */
  readonly tempoBpm: number | null;
  /** Time signature "4/4" style, when notated. */
  readonly meter: string | null;
  /** #358: anacrusis length in head-signature beats — a canonical
   *  fraction string ("1/1", "1/2") from the engine payload, null
   *  when the document carries no payload (fixture/foreign XML). */
  readonly pickupBeats: string | null;
  /** Key signature fifths (−7…+7), when notated. */
 readonly keyFifths: number | null;
  /** #252: key mode (major/minor) when the document declares one; null
   *  keeps the major default for legacy MusicXML without <mode>. */
  readonly keyMode: KeyMode | null;
  /** #146: key changes with measure numbers (head first); empty or
   *  single-entry = the piece stays in keyFifths. */
  readonly keyChanges: readonly { measure: number; fifths: number; mode: KeyMode | null }[];
  /** #249: tempo-map marks in document order (head first). startBeat
   *  is the canonical segment's beat when the document carries an
   *  engine payload - the remove/edit edits need the exact beat; a
   *  fixture or foreign document leaves it undefined and the tempo
   *  editor stays display-only. */
  readonly tempoChanges: readonly {
    measure: number;
    bpm: number;
    startBeat?: string;
  }[];
  /** #134: the score carries a swing marking (<sound><swing>). */
  readonly swingFeel: boolean;
  /** Number of measures in the score. */
  readonly measureCount: number;
  /** Number of canonical `sn-*` notes (rests excluded). */
  readonly noteCount: number;
  /** #272: review issues detected by the engine but omitted by the
   *  surfacing cap — the review bar shows them so a truncated list
   *  is never silent. */
  readonly omittedIssueCount: number;
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
  /** #156: whether the document carries the presentation at all -
   *  B-flat written XML arrived mid-history, so older documents,
   *  fixtures and mock results may lack it. The UI gates the B♭
   *  segment/command on this instead of guessing. Optional so fixture
   *  ports that predated the method keep compiling (treated as all-
   *  available when absent is NOT honest - default implementation
   *  must answer truthfully). */
  supportsPitchView?(view: PitchViewSetting): boolean;
  /** Review issues for this score revision (any status), with user
   *  decisions recorded via `recordReviewDecision` already applied. */
  reviewIssues(): readonly ScoreReviewIssue[];
  // #360: detected issues still deferred behind the surfacing cap —
  //  kept verbatim so they persist across save/reopen; empty or absent
  //  when the document has none (fixtures, older results).
  deferredReviewIssues?(): readonly ScoreReviewIssue[];
  // #360: merge the deferred cap-omitted issues into the live review
  //  list — they join as ordinary open issues (markers, prev/next,
  //  decisions all apply). Returns the count added, 0 when nothing is
  //  deferred. View-level op: not part of the undo stack.
  expandOmittedIssues?(): number;
  /**
   * Persist a review decision against (issueId, this revision) — the
   * document-model record the project-file adapter will later serialize.
   */
  recordReviewDecision(issueId: string, status: ReviewIssueStatus): void;
  /** Current canonical-note edits (`sn-*` id → edit). */
  noteEdits(): ReadonlyMap<string, ScoreNoteEdit>;
  /** Set or clear (`null` / empty edit) a canonical note's correction. */
  setNoteEdit(canonicalId: string, edit: ScoreNoteEdit | null): void;

  /* ---- #115 (spec 13): rhythm edits via the engine ----
   * These three are optional: only engine-backed documents can rebuild
   * notation. The workspace gates rhythm edits on a non-null
   * canonicalDocument() — a document without the canonical payload
   * (fixtures, dev) has nothing to send to score.edit, so the edit
   * stays unavailable (honest, never faked). */
  /** The canonical scoreDocument dict (schema v1 content) the engine's
   *  score.edit needs as its base — #224: with pending note edits
   *  materialized into it, or null for non-engine sources. */
  canonicalDocument?(): unknown | null;
  /** #224: is the canonical note itself deleted (rest-rendered by the
   *  engine payload — not just overlaid by a UI edit)? Lets the UI
   *  tell a materialized delete apart from a pending overlay one. */
  canonicalNoteDeleted?(canonicalId: string): boolean;
  /** #224: overlay edits that survive materialization into the
   *  canonical payload (enharmonic-only, live notes only) — the
   *  workspace passes these as next.noteEdits after an engine edit. */
  materializedNoteEdits?(newCanonicalDoc: unknown): ReadonlyMap<string, ScoreNoteEdit>;
  // #392: overlay rebase for ASYNC engine edits — requestOverlay is
  // the edit set the engine consumed at request time; entries the
  // user created or changed while the RPC was in flight rebase onto
  // newCanonicalDoc instead of being dropped as already-materialized.
  // Edits whose target note the engine merged away count in
  // conflicts — a silent drop is never acceptable.
  rebasedNoteEdits?(
    newCanonicalDoc: unknown,
    requestOverlay: ReadonlyMap<string, ScoreNoteEdit>,
  ): { edits: ReadonlyMap<string, ScoreNoteEdit>; conflicts: number };
  /** The current XML bodies + revision — the undo-stack snapshot for
   *  engine-driven content swaps. */
  contentSnapshot?(): {
    concertXml: string;
    hornXml: string;
    bFlatXml?: string;
    revisionId: string;
    canonicalDocument: unknown;
    /** #224: pending note edits are part of the snapshot — a rhythm
     *  edit materializes them into the canonical payload, so undo must
     *  restore the overlay too. */
    noteEdits: ReadonlyMap<string, ScoreNoteEdit>;
  };
  /** Swap the document's content in place (engine rhythm edit): same
   *  object, new bodies + revision + meta. The workspace re-renders via
   *  editVersion — selection and the undo stack survive, unlike a
   *  remount. */
  replaceContent?(next: {
    concertXml: string;
    hornXml: string;
    bFlatXml?: string;
    revisionId: string;
    canonicalDocument: unknown;
    /** #224: overlay edits to restore after the swap — the caller
     *  passes the materialized remainder (usually enharmonic-only). */
    noteEdits?: ReadonlyMap<string, ScoreNoteEdit>;
  }): void;
}
