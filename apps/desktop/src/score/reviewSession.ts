/**
 * ReviewSession — the command-side model of the 要確認 workspace (UI-050,
 * GUI_UX_SPEC §12/§14).
 *
 * All review interactions are recorded as `ReviewEdit`s: a status decision
 * (accept / dismiss / reopen) plus any note corrections (pitch shift,
 * delete/restore) the action produced. Each edit is pushed onto an undo
 * stack; undo/redo replay the inverse/forward values through the document
 * port, so decisions and corrections persist in the document model
 * (revision-bound — a new `scoreRevision` builds a new document and a new
 * session, so stale decisions are never carried across revisions, matching
 * the domain/review.py contract).
 *
 * The class is pure TypeScript — no React, no DOM — so the whole review
 * flow (including the keyboard-only acceptance path) is unit-testable.
 */
import type { ScoreDocumentPort } from "./document";
import { openIssues, type ReviewIssueStatus, type ScoreReviewIssue } from "./review";
import { NO_NOTE_EDIT, type ScoreNoteEdit } from "./scoreEdits";

/** One canonical note's before/after edit inside a ReviewEdit. */
export interface ReviewNoteChange {
  readonly canonicalId: string;
  readonly prev: ScoreNoteEdit;
  readonly next: ScoreNoteEdit;
}

/** #115: an engine rhythm edit's undo payload — the document's full
 *  content before/after the score.edit swap (XML bodies + revision +
 *  canonical payload). Snapshots come from ScoreDocumentPort's
 *  contentSnapshot()/replaceContent(); documents without those port
 *  methods (fixtures) simply cannot produce a docSwap. */
export interface DocSwap {
  readonly prev: {
    readonly concertXml: string;
    readonly hornXml: string;
    readonly revisionId: string;
    readonly canonicalDocument: unknown;
  };
  readonly next: {
    readonly concertXml: string;
    readonly hornXml: string;
    readonly revisionId: string;
    readonly canonicalDocument: unknown;
  };
}

/** A recorded review action - the undo/redo unit (§14 "review decision"). */
export interface ReviewEdit {
  /** Issue this edit is bound to; null for a direct note edit made
   *  outside the review workspace (#114 - the undo stack is shared). */
  readonly issueId: string | null;
  readonly prevStatus: ReviewIssueStatus | null;
  readonly nextStatus: ReviewIssueStatus | null;
  /** Note corrections applied alongside the status change (empty for a
   *  pure decision like 問題なし). */
  readonly noteChanges: readonly ReviewNoteChange[];
  /** #115: engine rhythm edits swap the document's whole content;
   *  undo/redo restore the snapshot pair instead of note-level edits. */
  readonly docSwap?: DocSwap;
}

function editOf(doc: ScoreDocumentPort, canonicalId: string): ScoreNoteEdit {
  return doc.noteEdits().get(canonicalId) ?? NO_NOTE_EDIT;
}

export class ReviewSession {
  private readonly undoStack: ReviewEdit[] = [];
  private readonly redoStack: ReviewEdit[] = [];

  constructor(private readonly doc: ScoreDocumentPort) {}

  /** The revision these decisions are bound to. */
  get scoreRevision(): string {
    return this.doc.revisionId;
  }

  /** All issues with decisions applied (any status). */
  issues(): readonly ScoreReviewIssue[] {
    return this.doc.reviewIssues();
  }

  /** Issues still needing attention. */
  openIssues(): readonly ScoreReviewIssue[] {
    return openIssues(this.doc.reviewIssues());
  }

  pendingCount(): number {
    return this.openIssues().length;
  }

  statusOf(issueId: string): ReviewIssueStatus | null {
    return (
      this.doc.reviewIssues().find((i) => i.id === issueId)?.status ?? null
    );
  }

  noteEditOf(canonicalId: string): ScoreNoteEdit {
    return editOf(this.doc, canonicalId);
  }

  isDeleted(canonicalId: string): boolean {
    return editOf(this.doc, canonicalId).deleted;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Record a pure decision (accepted / dismissed / back to open).
   * Returns null when the issue is unknown or already in that status —
   * callers treat that as a no-op, not an error.
   */
  decide(issueId: string, status: ReviewIssueStatus): ReviewEdit | null {
    const issue = this.doc.reviewIssues().find((i) => i.id === issueId);
    if (!issue || issue.status === status) return null;
    const edit: ReviewEdit = {
      issueId,
      prevStatus: issue.status,
      nextStatus: status,
      noteChanges: [],
    };
    this.doc.recordReviewDecision(issueId, status);
    this.push(edit);
    return edit;
  }

  /**
   * 音高修正: shift every canonical note of the issue by `delta` semitones
   * and mark the issue 修正済み (a correction IS a resolution).
   */
  adjustPitch(issueId: string, delta: number): ReviewEdit | null {
    const issue = this.doc.reviewIssues().find((i) => i.id === issueId);
    if (!issue || issue.canonicalNoteIds.length === 0 || delta === 0) {
      return null;
    }
    const noteChanges: ReviewNoteChange[] = issue.canonicalNoteIds.map(
      (canonicalId) => {
        const prev = editOf(this.doc, canonicalId);
        const next: ScoreNoteEdit = {
          ...prev,
          pitchDelta: prev.pitchDelta + delta,
        };
        return { canonicalId, prev, next };
      },
    );
    return this.apply({
      issueId,
      prevStatus: issue.status,
      nextStatus: "fixed",
      noteChanges,
    });
  }

  /**
   * 削除/復元: toggle the deleted flag on the issue's canonical notes.
   * Deleting counts as a correction (→ fixed); restoring reopens the issue
   * so the passage is checked again.
   */
  setNoteDeleted(issueId: string, deleted: boolean): ReviewEdit | null {
    const issue = this.doc.reviewIssues().find((i) => i.id === issueId);
    if (!issue || issue.canonicalNoteIds.length === 0) return null;
    const noteChanges: ReviewNoteChange[] = [];
    for (const canonicalId of issue.canonicalNoteIds) {
      const prev = editOf(this.doc, canonicalId);
      if (prev.deleted === deleted) continue;
      noteChanges.push({ canonicalId, prev, next: { ...prev, deleted } });
    }
    const nextStatus: ReviewIssueStatus = deleted ? "fixed" : "open";
    // No-op guard: notes already in the target state AND the status too.
    if (noteChanges.length === 0 && issue.status === nextStatus) return null;
    return this.apply({
      issueId,
      prevStatus: issue.status,
      nextStatus,
      noteChanges,
    });
  }

  /** Reopen an issue without touching note edits (revert a decision). */
  reopen(issueId: string): ReviewEdit | null {
    return this.decide(issueId, "open");
  }

  /** #114 (spec 13): edit a canonical note directly, outside any review
   *  issue - pitch shift, delete/restore and enharmonic respell share
   *  the same undo stack as review corrections. `patch` is applied on
   *  top of the note's current edit; returns null on a no-op. */
  editNote(
    canonicalId: string,
    patch: Partial<ScoreNoteEdit>,
  ): ReviewEdit | null {
    const prev = editOf(this.doc, canonicalId);
    const next: ScoreNoteEdit = { ...prev, ...patch };
    if (
      next.pitchDelta === prev.pitchDelta &&
      next.deleted === prev.deleted &&
      (next.enharmonic ?? false) === (prev.enharmonic ?? false)
    ) {
      return null;
    }
    const edit: ReviewEdit = {
      issueId: null,
      prevStatus: null,
      nextStatus: null,
      noteChanges: [{ canonicalId, prev, next }],
    };
    this.doc.setNoteEdit(canonicalId, next);
    this.push(edit);
    return edit;
  }

  /** #115 (spec 13): record an engine rhythm edit on the shared undo
   *  stack. The caller captures `prev` via doc.contentSnapshot()
   *  BEFORE applying doc.replaceContent(next) — snapshotting here would
   *  already see the new content and undo would restore nothing.
   *  Returns null when the document cannot snapshot (fixture/dev
   *  documents: rhythm edits stay unavailable there, matching the
   *  honest-disabled policy). */
  commitDocSwap(prev: DocSwap["prev"], next: DocSwap["next"]): ReviewEdit | null {
    if (!this.doc.replaceContent) return null;
    const edit: ReviewEdit = {
      issueId: null,
      prevStatus: null,
      nextStatus: null,
      noteChanges: [],
      docSwap: { prev, next },
    };
    this.push(edit);
    return edit;
  }

  /** Undo the most recent review action. Returns it, or null when the
   *  stack is empty. */
  undo(): ReviewEdit | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    this.applyInverse(edit);
    this.redoStack.push(edit);
    return edit;
  }

  /** Redo the most recently undone action. */
  redo(): ReviewEdit | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    this.applyForward(edit);
    this.undoStack.push(edit);
    return edit;
  }

  /* ------------------------- internals ------------------------- */

  private push(edit: ReviewEdit): void {
    this.undoStack.push(edit);
    this.redoStack.length = 0; // a new action invalidates the redo tail
  }

  private apply(edit: ReviewEdit): ReviewEdit {
    for (const change of edit.noteChanges) {
      this.doc.setNoteEdit(change.canonicalId, change.next);
    }
    if (edit.issueId != null && edit.nextStatus != null) {
      this.doc.recordReviewDecision(edit.issueId, edit.nextStatus);
    }
    this.push(edit);
    return edit;
  }

  private applyInverse(edit: ReviewEdit): void {
    // Restore note edits first, then the status - a consumer that
    // re-renders once sees a consistent state either way.
    if (edit.docSwap) {
      this.doc.replaceContent?.(edit.docSwap.prev);
      return;
    }
    for (const change of edit.noteChanges) {
      this.doc.setNoteEdit(change.canonicalId, change.prev);
    }
    if (edit.issueId != null && edit.prevStatus != null) {
      this.doc.recordReviewDecision(edit.issueId, edit.prevStatus);
    }
  }

  private applyForward(edit: ReviewEdit): void {
    if (edit.docSwap) {
      this.doc.replaceContent?.(edit.docSwap.next);
      return;
    }
    for (const change of edit.noteChanges) {
      this.doc.setNoteEdit(change.canonicalId, change.next);
    }
    if (edit.issueId != null && edit.nextStatus != null) {
      this.doc.recordReviewDecision(edit.issueId, edit.nextStatus);
    }
  }
}
