/**
 * #343: the Review quick-retranscribe actions mirror their option
 * choice into 採譜オプション/global settings AND start a job. On a
 * dirty score the 未保存確認 must guard BOTH — a キャンセル that leaves
 * settings mutated is a destructive action wearing a cancel costume.
 *
 * This helper is the transaction contract, kept pure so the guard
 * semantics are unit-testable without mounting App.
 */

export interface RetranscribeRequest {
  /** A source must be loaded — re-transcription replaces the score. */
  readonly audioLoaded: boolean;
  /** Unsaved edits on the live score (dirtyRef mirror). */
  readonly dirty: boolean;
  /** Mirror the option choice into 採譜オプション/settings. Must run
   *  only when the job will actually start — never on cancel. */
  readonly commitOptions: () => void;
  /** Start the transcription job; `skipGuard` applies on the deferred
   *  re-entry so the pending closure does not re-guard itself (#347). */
  readonly startJob: (skipGuard: boolean) => void;
  /** Queue an action behind the 未保存確認 dialog. */
  readonly queuePending: (action: () => void) => void;
  /** Announce the no-source state (relink banner path). */
  readonly onNoAudio: () => void;
}

/** Run the option-commit + job-start pair as one guarded action: dirty
 *  queues the whole pair, clean runs it now, no-audio announces and
 *  mutates nothing. */
export function requestRetranscription(req: RetranscribeRequest): void {
  if (!req.audioLoaded) {
    req.onNoAudio();
    return;
  }
  if (req.dirty) {
    req.queuePending(() => {
      // The user's 続ける choice commits the mirror and starts the
      // job with the guard already answered (#347 skipGuard).
      req.commitOptions();
      req.startJob(true);
    });
    return;
  }
  req.commitOptions();
  req.startJob(false);
}
