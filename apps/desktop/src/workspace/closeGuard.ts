/**
 * #400: window close-request decision — which confirmation (if any)
 * owns a close while the app has something worth keeping. Kept pure
 * so the priority contract is unit-testable without mounting App.
 *
 * Priorities: unsaved data first (a dirty score is the only thing a
 * save can preserve), then recording (irreplaceable capture), then a
 * running transcription (lost compute time, no data destroyed).
 * dirty+transcribing is its own kind — the dialog must say BOTH the
 * job dies AND unsaved edits are lost, one confirmation not two.
 */
export type PendingCloseKind =
  | "dirty"
  | "recording"
  | "transcribing"
  | "dirtyTranscribing";

export function closeGuardKind(input: {
  readonly dirty: boolean;
  readonly recording: boolean;
  readonly transcribing: boolean;
}): PendingCloseKind | null {
  if (input.dirty && input.transcribing) return "dirtyTranscribing";
  if (input.dirty) return "dirty";
  if (input.recording) return "recording";
  if (input.transcribing) return "transcribing";
  return null;
}

