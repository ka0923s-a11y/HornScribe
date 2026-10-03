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
    readonly noteEdits: ReadonlyMap<string, ScoreNoteEdit>;
  };
  readonly next: {
    readonly concertXml: string;
    readonly hornXml: string;
    readonly revisionId: string;
    readonly canonicalDocument: unknown;
    readonly noteEdits?: ReadonlyMap<string, ScoreNoteEdit>;
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
  /** #167: members of one batch decision (decideMany) share a group id —
   *  undo/redo treat the contiguous run as a single user action. */
  readonly groupId?: number;
}

function editOf(doc: ScoreDocumentPort, canonicalId: string): ScoreNoteEdit {
  const overlay = doc.noteEdits().get(canonicalId);
  if (overlay) return overlay;
  // #224: a canonical-deleted note IS deleted even with no overlay —
  // the effective edit reports it so isDeleted/toggles stay honest.
  if (doc.canonicalNoteDeleted?.(canonicalId)) {
    return { ...NO_NOTE_EDIT, deleted: true };
  }
  return NO_NOTE_EDIT;
}

export class ReviewSession {
  private readonly undoStack: ReviewEdit[] = [];
  private readonly redoStack: ReviewEdit[] = [];
  /** #167: monotonically increasing batch id — session-local, so a plain
   *  counter beats a uuid for test determinism. */
  private groupCounter = 0;

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

  // #392: undo-stack depth — the workspace records it when an async
  // engine edit starts, so a late response can commit UNDER the
  // edits the user made while the engine was working.
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /**
   * Record a pure decision (accepted / dismissed / back to open).
   * Returns null when the issue is unknown or already in that status —
   * callers treat that as a no-op, not an error.
   */
  decide(
    issueId: string,
    status: ReviewIssueStatus,
    groupId?: number,
  ): ReviewEdit | null {
    const issue = this.doc.reviewIssues().find((i) => i.id === issueId);
    if (!issue || issue.status === status) return null;
    const edit: ReviewEdit = {
      issueId,
      prevStatus: issue.status,
      nextStatus: status,
      noteChanges: [],
      ...(groupId != null ? { groupId } : {}),
    };
    this.doc.recordReviewDecision(issueId, status);
    this.push(edit);
    return edit;
  }

  /**
   * #167: decide several issues as ONE undoable action — the review
   *  workspace's "同じ理由をまとめて問題なし" path. Each member goes
   *  through the same per-issue no-op rule as decide(); the applied
   *  subset shares one groupId so a single undo reverts the batch.
   *  Returns the applied edits (empty when every id was a no-op).
   */
  decideMany(
    issueIds: readonly string[],
    status: ReviewIssueStatus,
  ): readonly ReviewEdit[] {
    const groupId = ++this.groupCounter;
    const applied: ReviewEdit[] = [];
    for (const issueId of issueIds) {
      const edit = this.decide(issueId, status, groupId);
      if (edit) applied.push(edit);
    }
    return applied;
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
  commitDocSwap(
    prev: DocSwap["prev"],
    next: DocSwap["next"],
    insertBelow = 0,
  ): ReviewEdit | null {
    if (!this.doc.replaceContent) return null;
    const edit: ReviewEdit = {
      issueId: null,
      prevStatus: null,
      nextStatus: null,
      noteChanges: [],
      docSwap: { prev, next },
    };
    if (insertBelow > 0) {
      // #392: a late engine response commits UNDER the edits the user
      // made while it was in flight — undo order stays user-op order.
      const idx = Math.max(0, this.undoStack.length - insertBelow);
      this.undoStack.splice(idx, 0, edit);
      this.redoStack.length = 0;
    } else {
      this.push(edit);
    }
    return edit;
  }

  /** Undo the most recent review action. Returns it, or null when the
   *  stack is empty. */
  undo(): ReviewEdit | null {
    const first = this.undoStack.pop();
    if (!first) return null;
    // #167: a batched decision undoes as one — keep popping while the
    //  run shares the group id, invert in pop (reverse-apply) order,
    //  and move the whole run to the redo stack.
    const batch = [first];
    if (first.groupId != null) {
      while (
        this.undoStack.length > 0 &&
        this.undoStack[this.undoStack.length - 1].groupId === first.groupId
      ) {
        batch.push(this.undoStack.pop()!);
      }
    }
    for (const edit of batch) {
      this.applyInverse(edit);
      this.redoStack.push(edit);
    }
    // The last-popped edit is the batch's earliest member — its issueId
    //  is the friendliest cursor target for "where did that undo land".
    return batch[batch.length - 1];
  }

  /** Redo the most recently undone action. */
  redo(): ReviewEdit | null {
    const first = this.redoStack.pop();
    if (!first) return null;
    // Mirror of undo()'s grouping — the run comes back in original
    //  apply order, landing on the undo stack exactly as before.
    const batch = [first];
    if (first.groupId != null) {
      while (
        this.redoStack.length > 0 &&
        this.redoStack[this.redoStack.length - 1].groupId === first.groupId
      ) {
        batch.push(this.redoStack.pop()!);
      }
    }
    for (const edit of batch) {
      this.applyForward(edit);
      this.undoStack.push(edit);
    }
    return batch[batch.length - 1];
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
