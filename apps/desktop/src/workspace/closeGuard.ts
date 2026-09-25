/**
 * #400: window close-request decision — which confirmation (if any)
 * owns a close while the app has something worth keeping. Kept pure
 * so the priority contract is unit-testable without mounting App.
 *
 * Priorities: two irreplaceable data sources first — dirty+recording
 * means BOTH an unsaved score and a live take are at stake (#301
 * re-review), one combined confirmation, never a dirty-only dialog
 * that silently kills the take. Then dirty+transcribing (score edits
 * plus a dying job), then each hazard alone. A transcription under
 * recording loses the tie: the take cannot be re-captured, the job
 * can be re-run.
 */
export type PendingCloseKind =
  | "dirty"
  | "recording"
  | "transcribing"
  | "dirtyRecording"
  | "dirtyTranscribing";

export function closeGuardKind(input: {
  readonly dirty: boolean;
  readonly recording: boolean;
  readonly transcribing: boolean;
}): PendingCloseKind | null {
  if (input.dirty && input.recording) return "dirtyRecording";
  if (input.dirty && input.transcribing) return "dirtyTranscribing";
  if (input.dirty) return "dirty";
  if (input.recording) return "recording";
  if (input.transcribing) return "transcribing";
  return null;
}
