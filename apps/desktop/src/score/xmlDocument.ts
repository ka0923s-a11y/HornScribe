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
  /** #272: issues the engine detected but the surfacing cap omitted. */
  readonly omittedIssueCount?: number;
}

export class XmlScoreDocument implements ScoreDocumentPort {
  private _revisionId: string;
  private _meta: ScoreDocumentMeta;
  private concertXml: string;
  private hornXml: string;
  private canonicalDoc: unknown | null;
  private issues: readonly ScoreReviewIssue[];
  private _omittedIssueCount = 0;
  private decisions = new Map<string, ReviewIssueStatus>();
  /** #225: decisions/issues are revision-bound — a score.edit swap
   *  mints a new revision, so the old revision's set is stashed here
   *  and a swap back (undo) restores exactly that revision's state. */
  private readonly issuesByRevision = new Map<
    string,
    readonly ScoreReviewIssue[]
  >();
  private readonly decisionsByRevision = new Map<
    string,
    Map<string, ReviewIssueStatus>
  >();
  private readonly edits = new Map<string, ScoreNoteEdit>();
  private editCounter = 0;
  /** #224: canonical ids whose QuantizedNote carries deleted:true —
   *  rebuilt on every content swap. A materialized delete stays
   *  rest-rendered by the engine itself; the overlay only tracks
   *  pending (unmaterialized) edits. */
  private canonicalDeletedIds = new Set<string>();

  constructor(src: XmlScoreDocumentSources) {
    this._revisionId = src.revisionId;
    this.issues = src.issues;
    this.concertXml = src.concertXml;
    this.hornXml = src.hornXml;
    this.canonicalDoc = src.canonicalDocument ?? null;
    this.canonicalDeletedIds = deletedIdsOf(this.canonicalDoc);
    this._meta = XmlScoreDocument.computeMeta(src.concertXml);
    this._omittedIssueCount = src.omittedIssueCount ?? 0;
    this._meta = {
      ...this._meta,
      tempoChanges: mergeTempoStarts(
        this._meta.tempoChanges,
        this.canonicalDoc,
      ),
      pickupBeats: pickupBeatsOf(this.canonicalDoc),
      omittedIssueCount: this._omittedIssueCount,
    };
  }

  private static computeMeta(xml: string): ScoreDocumentMeta {
    const doc = parseScoreDoc(xml);
    const canonical = new Set(
      doc.notes.map((n) => n.canonicalId).filter(Boolean),
    );
    return {
      title: doc.title,
      composer: doc.composer,
      arranger: doc.arranger,
      tempoBpm: doc.tempoBpm,
      meter: doc.meter,
     keyFifths: doc.keyFifths,
     keyChanges: doc.keyChanges,
      tempoChanges: doc.tempoChanges,
      keyMode: doc.keyMode,
      // #358: MusicXML expresses the pickup implicitly (partial
      // first measure); the canonical payload is authoritative, so
      // computeMeta leaves null and the caller merges pickupBeatsOf.
      pickupBeats: null,
      swingFeel: doc.swingFeel,
      measureCount: doc.measureCount,
      noteCount: canonical.size,
      omittedIssueCount: 0,
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
    // #224: the canonical note map lets the overlay also RESTORE —
    // a deleted:false edit on a canonical-deleted note re-pitches the
    // emitted rest from the canonical pitchMidi.
    return applyNoteEdits(base, this.edits, this.canonicalDoc);
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
    // #224: canonical-aware emptiness — restoring a canonical-deleted
    // note is {deleted:false}, which isEmptyNoteEdit would call empty
    // yet MUST be stored so the next materialization revives the note.
    const neutral: ScoreNoteEdit = {
      pitchDelta: 0,
      deleted: this.canonicalDeletedIds.has(canonicalId),
      enharmonic: false,
    };
    const isNeutral =
      edit == null ||
      (edit.pitchDelta === neutral.pitchDelta &&
        edit.deleted === neutral.deleted &&
        (edit.enharmonic ?? false) === neutral.enharmonic);
    if (isNeutral) this.edits.delete(canonicalId);
    else this.edits.set(canonicalId, edit);
    this.editCounter += 1;
  }

  /* ---- #115: engine rhythm edits swap content in place ---- */

  canonicalNoteDeleted(canonicalId: string): boolean {
    return this.canonicalDeletedIds.has(canonicalId);
  }

  canonicalDocument(): unknown | null {
    // #224: the engine edits the score the user SEES — pending overlay
    // edits (pitchDelta/deleted) are materialized into the canonical
    // payload before score.edit, so split/merge/requantize can never
    // resurrect or contradict them. Enharmonic spelling is notation-
    // only and stays in the overlay.
    if (this.canonicalDoc == null) return null;
    if (this.edits.size === 0) return this.canonicalDoc;
    return materializeCanonicalEdits(this.canonicalDoc, this.edits);
  }

  contentSnapshot() {
    return {
      concertXml: this.concertXml,
      hornXml: this.hornXml,
      revisionId: this._revisionId,
      canonicalDocument: this.canonicalDoc,
      noteEdits: new Map(this.edits),
    };
  }

  /** #224: the overlay edits that survive materialization — passed as
   *  next.noteEdits on the post-edit content swap. Only enharmonic
   *  respelling stays overlaid (canonical stores sounding pitch, not
   *  spelling); edits on notes the engine removed are dropped. */
  materializedNoteEdits(newCanonicalDoc: unknown): Map<string, ScoreNoteEdit> {
    // #392: the special case of rebasedNoteEdits where the current
    // overlay IS the request set — no in-flight delta exists, so only
    // the materialized remainder (enharmonic on live notes) survives.
    return this.rebasedNoteEdits(newCanonicalDoc, this.edits).edits;
  }

  // #392: async-edit rebase. requestOverlay is the exact edit set the
  // engine consumed; the CURRENT this.edits may carry entries the
  // user added or changed while the RPC was in flight. Those deltas
  // rebase onto the new canonical doc - a target the engine merged
  // away is a conflict, never a silent drop. Entries unchanged since
  // the request use materialized semantics (enharmonic-only on live
  // notes); entries the user CLEARED in flight stay cleared.
  rebasedNoteEdits(
    newCanonicalDoc: unknown,
    requestOverlay: ReadonlyMap<string, ScoreNoteEdit>,
  ): { edits: Map<string, ScoreNoteEdit>; conflicts: number } {
    const liveIds = liveNoteIdsOf(newCanonicalDoc);
    const deletedIds = deletedIdsOf(newCanonicalDoc);
    const keep = new Map<string, ScoreNoteEdit>();
    let conflicts = 0;
    const cleared = new Set<string>();
    for (const id of requestOverlay.keys()) {
      if (!this.edits.has(id)) cleared.add(id);
    }
    for (const [id, edit] of requestOverlay) {
      if (cleared.has(id)) continue;
      const now = this.edits.get(id);
      const unchanged =
        now !== undefined &&
        now.pitchDelta === edit.pitchDelta &&
        now.deleted === edit.deleted &&
        (now.enharmonic ?? false) === (edit.enharmonic ?? false);
      if (!unchanged) continue; // the delta loop owns changed entries
      if (!liveIds.has(id)) continue;
      if (edit.enharmonic && !deletedIds.has(id)) {
        keep.set(id, { pitchDelta: 0, deleted: false, enharmonic: true });
      }
    }
    for (const [id, edit] of this.edits) {
      const was = requestOverlay.get(id);
      const unchanged =
        was !== undefined &&
        was.pitchDelta === edit.pitchDelta &&
        was.deleted === edit.deleted &&
        (was.enharmonic ?? false) === (edit.enharmonic ?? false);
      if (unchanged) continue; // already materialized, handled above
      if (!liveIds.has(id)) {
        conflicts += 1;
        continue;
      }
      if (deletedIds.has(id)) {
        // The engine itself removed the note - a matching delete is
        // already materialized; any other intent would resurrect a
        // merged note on the next materialization, so it conflicts.
        if (!edit.deleted) conflicts += 1;
        continue;
      }
      keep.set(id, edit);
    }
    return { edits: keep, conflicts };
  }

  /** Swap XML bodies + revision + canonical payload in place. Meta is
   *  recomputed from the new concert XML (measure/note counts can move).
   *  Review decisions survive — canonical ids are stable, and the
   *  session's undo stack keeps working across the swap. #224: the
   *  overlay edits are replaced by next.noteEdits (the materialized
   *  remainder); callers pass materializedNoteEdits() after an engine
   *  edit, or the snapshot's own map on undo/redo. */
  replaceContent(next: {
    concertXml: string;
    hornXml: string;
    revisionId: string;
    canonicalDocument: unknown;
    noteEdits?: ReadonlyMap<string, ScoreNoteEdit>;
  }): void {
    if (next.revisionId !== this._revisionId) {
      // #225: stash the outgoing revision's issue set + decisions, then
      // restore the incoming revision's own set (empty for a revision
      // never seen — a score.edit result carries no issue list).
      this.issuesByRevision.set(this._revisionId, this.issues);
      this.decisionsByRevision.set(this._revisionId, this.decisions);
      this.issues = this.issuesByRevision.get(next.revisionId) ?? [];
      this.decisions =
        this.decisionsByRevision.get(next.revisionId) ?? new Map();
    }
    this.concertXml = next.concertXml;
    this.hornXml = next.hornXml;
    this._revisionId = next.revisionId;
    this.canonicalDoc = next.canonicalDocument;
    this.canonicalDeletedIds = deletedIdsOf(this.canonicalDoc);
    if (next.noteEdits !== undefined) {
      this.edits.clear();
      for (const [id, edit] of next.noteEdits) {
        this.edits.set(id, edit);
      }
    }
    this._meta = XmlScoreDocument.computeMeta(next.concertXml);
    this._meta = {
      ...this._meta,
      tempoChanges: mergeTempoStarts(
        this._meta.tempoChanges,
        this.canonicalDoc,
      ),
      pickupBeats: pickupBeatsOf(this.canonicalDoc),
      omittedIssueCount: this._omittedIssueCount,
    };
    this.editCounter += 1;
  }
}

/** #249: attach the canonical tempo segment's exact startBeat to each
 *  parsed <sound tempo> mark. The notation emits one mark per segment
 *  in order, so a same-length zip is safe; any mismatch (foreign
 *  document, hand-edited XML) leaves startBeat undefined and the tempo
 *  editor degrades to display-only instead of guessing beats. */
function mergeTempoStarts(
  marks: readonly { measure: number; bpm: number }[],
  canonicalDoc: unknown,
): { measure: number; bpm: number; startBeat?: string }[] {
  const content = (
    canonicalDoc as { content?: { tempoMap?: { startBeat?: unknown }[] } }
  )?.content;
  const map = Array.isArray(content?.tempoMap) ? content.tempoMap : null;
  return marks.map((m, i) => {
    const seg = map && map.length === marks.length ? map[i] : null;
    const startBeat = seg?.startBeat;
    return typeof startBeat === "string"
      ? { ...m, startBeat }
      : { ...m };
  });
}

/** #358: canonical anacrusis in beat units ("1/1", "1/2" fraction
 *  strings). Read from the payload like tempoMap's startBeat — a
 *  fixture or foreign document leaves null and the pickup field
 *  degrades to display-only. */
function pickupBeatsOf(canonicalDoc: unknown): string | null {
  const content = (
    canonicalDoc as { content?: { pickupBeats?: unknown } }
  )?.content;
  const raw = content?.pickupBeats;
  return typeof raw === "string" && /^\d+\/\d+$/.test(raw)
    ? raw
    : null;
}

/* ------------------------- #224: canonical edits -------------------------
 * The canonical payload is the single source of truth for engine edits:
 * pending overlay edits are materialized into it before score.edit so
 * split/merge/requantize operate on what the user sees. */

/** Canonical ids whose QuantizedNote carries deleted:true. */
function deletedIdsOf(canonicalDoc: unknown): Set<string> {
  const ids = new Set<string>();
  for (const n of canonicalNotesOf(canonicalDoc)) {
    if (n.deleted === true && typeof n.id === "string") ids.add(n.id);
  }
  return ids;
}

/** Canonical ids still present as live notes (deleted or not — a
 *  deleted note keeps its id; a merged-away note loses it). */
function liveNoteIdsOf(canonicalDoc: unknown): Set<string> {
  const ids = new Set<string>();
  for (const n of canonicalNotesOf(canonicalDoc)) {
    if (typeof n.id === "string") ids.add(n.id);
  }
  return ids;
}

function canonicalNotesOf(
  canonicalDoc: unknown,
): readonly Record<string, unknown>[] {
  const content = (canonicalDoc as { content?: { parts?: unknown } })
    ?.content;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return [];
  const out: Record<string, unknown>[] = [];
  for (const part of parts) {
    const notes = (part as { notes?: unknown }).notes;
    if (!Array.isArray(notes)) continue;
    for (const n of notes) {
      if (typeof n === "object" && n !== null) {
        out.push(n as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** Deep-clone the canonical payload and bake the overlay edits into it:
 *  pitchDelta -> pitchMidi offset, deleted -> the canonical deleted
 *  flag (both directions — an overlay restore clears it). Enharmonic
 *  spelling is notation-only and stays overlaid. Notes the overlay
 *  references but the payload lacks are ignored. */
export function materializeCanonicalEdits(
  canonicalDoc: unknown,
  edits: ReadonlyMap<string, ScoreNoteEdit>,
): unknown {
  const clone = JSON.parse(JSON.stringify(canonicalDoc)) as Record<
    string,
    unknown
  >;
  const byId = new Map<string, Record<string, unknown>>();
  for (const n of canonicalNotesOf(clone)) {
    if (typeof n.id === "string") byId.set(n.id, n);
  }
  for (const [id, edit] of edits) {
    const n = byId.get(id);
    if (!n) continue;
    if (edit.pitchDelta !== 0 && typeof n.pitchMidi === "number") {
      n.pitchMidi = n.pitchMidi + edit.pitchDelta;
    }
    if (edit.deleted) {
      n.deleted = true;
    } else if (n.deleted === true) {
      // Overlay restore — the canonical flag clears.
      delete n.deleted;
    }
  }
  return clone;
}

/** Fields extracted from a completed transcription job's `result`. */
export interface EngineScoreDocumentInput {
  readonly concertXml: string;
  readonly hornXml: string;
  readonly revisionId: string;
  readonly issues: readonly ScoreReviewIssue[];
  /** #115: canonical scoreDocument dict from the job result. */
  readonly canonicalDocument?: unknown;
  /** #272: issues the engine detected but the surfacing cap omitted. */
  readonly omittedIssueCount?: number;
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
      omittedIssueCount: input.omittedIssueCount,
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
    // #272: meta.reviewSummary.omitted — the cap never truncates
    // silently; the review bar shows how many were left out.
    omittedIssueCount: (() => {
      const meta = r.meta as Record<string, unknown> | undefined;
      const summary = meta?.reviewSummary as
        Record<string, unknown> | undefined;
      const n = summary?.omitted;
      return typeof n === "number" && n > 0 ? n : 0;
    })(),
  };
}
