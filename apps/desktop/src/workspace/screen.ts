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
 *   SCORE_READY ├ review → REVIEWING ├ export → EXPORTING └ retranscribe
 */
export type ScreenState =
  | "empty"
  | "audioReady"
  | "transcribing"
  | "scoreReady"
  | "reviewing"
  | "exporting";

export const SCREEN_STATES: readonly ScreenState[] = [
  "empty",
  "audioReady",
  "transcribing",
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
}
