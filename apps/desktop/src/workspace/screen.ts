import type { CommandSnapshot } from "../commands/types";

/**
 * Workspace screen state machine (docs/GUI_UX_SPEC.md §27).
 *
 * The shell owns *which regions exist* for each state; feature code owns the
 * transitions (open audio → audioReady, transcribe → transcribing, …). For
 * UI-011 the live app still sits in `empty` (no file/engine plumbing yet),
 * but every state renders a correct layout so feature teams never invent
 * their own.
 *
 *   EMPTY ─open→ AUDIO_READY ─transcribe→ TRANSCRIBING
 *                                          ├ cancel → AUDIO_READY
 *                                          ├ fail   → TRANSCRIPTION_ERROR
 *                                          └ done   → SCORE_READY
 *   TRANSCRIPTION_ERROR ─dismiss/retry→ last valid state (audioReady or
 *   scoreReady — a prior score is never destroyed by a failed job).
 *   SCORE_READY ├ review → REVIEWING ├ export → EXPORTING └ retranscribe
 */
export type ScreenState =
  | "empty"
  | "audioReady"
  | "transcribing"
  // [UI-040] §27 TRANSCRIPTION_ERROR — job failed / worker crash or
  // unresponsive mid-job. A loaded state (audio/score state is kept).
  | "transcriptionError"
  | "scoreReady"
  | "reviewing"
  | "exporting";

export const SCREEN_STATES: readonly ScreenState[] = [
  "empty",
  "audioReady",
  "transcribing",
  "transcriptionError",
  "scoreReady",
  "reviewing",
  "exporting",
];

/**
 * Region visibility per state (§3 empty state shows none of the work
 * surfaces; §4+ show all once audio exists).
 */
export interface RegionVisibility {
  /** Waveform / timeline strip. */
  waveform: boolean;
  /** Score workspace region — always mounted (it carries the empty state). */
  score: boolean;
  /** Properties panel region — also gated by the user close/open toggle. */
  properties: boolean;
  /** Transport bar. */
  transport: boolean;
}

export function regionVisibility(screen: ScreenState): RegionVisibility {
  const loaded = screen !== "empty";
  return {
    waveform: loaded,
    score: true,
    // The panel itself decides open/closed; EMPTY never mounts it (§3).
    properties: loaded,
    transport: loaded,
  };
}

/**
 * Map the screen machine onto the UI-012 CommandSnapshot fields (§23) so
 * command enablement stays consistent: 採譜 needs audio and is disabled
 * while a transcription runs (§5), 要確認 needs a score with pending
 * issues, 書き出し needs a score. Playback/undo/selection fields are owned
 * by their feature issues, not by the screen machine.
 */
export function commandStateFor(
  screen: ScreenState,
): Pick<
  CommandSnapshot,
  "hasAudio" | "hasScore" | "isTranscribing" | "reviewOpen"
> {
  const hasScore =
    screen === "scoreReady" || screen === "reviewing" || screen === "exporting";
  return {
    hasAudio: screen !== "empty",
    hasScore,
    isTranscribing: screen === "transcribing",
    reviewOpen: screen === "reviewing",
  };
  // [UI-040] transcriptionError: hasAudio=true (loaded), isTranscribing
  // =false → 採譜 stays reachable as the retry path; hasScore=false keeps
  // score/export commands off while the §20 error surface is up.
}
