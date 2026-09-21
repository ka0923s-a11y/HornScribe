import type { CommandSnapshot } from "../commands/types";

/**
 * Workspace screen state machine (docs/GUI_UX_SPEC.md §27).
 *
 * The shell owns *which regions exist* for each state; feature code owns the
 * transitions (open audio → audioReady, transcribe → transcribing, …).
 * UI-020 added the import-side states (issue #25: EMPTY / OPENING_AUDIO /
 * AUDIO_READY / AUDIO_ERROR / SOURCE_MISSING).
 *
 *   EMPTY ─open→ OPENING_AUDIO ─ok→ AUDIO_READY ─transcribe→ TRANSCRIBING
 *                     │                                     ├ cancel → AUDIO_READY
 *                     ├ bad format/read → AUDIO_ERROR ─閉じる→ EMPTY
 *                     └ source moved → SOURCE_MISSING ─relink ok→ AUDIO_READY
 *                                            └ hash mismatch → SOURCE_MISSING
 *                                                       TRANSCRIBING
 *                                          ├ fail   → TRANSCRIPTION_ERROR
 *                                          └ done   → SCORE_READY
 *   TRANSCRIPTION_ERROR ─dismiss/retry→ last valid state (audioReady or
 *   scoreReady — a prior score is never destroyed by a failed job).
 *   SCORE_READY ├ review → REVIEWING ├ export → EXPORTING └ retranscribe
 */
export type ScreenState =
  | "empty"
  | "openingAudio"
  | "audioReady"
  | "audioError"
  | "sourceMissing"
  | "transcribing"
  // [UI-040] §27 TRANSCRIPTION_ERROR — job failed / worker crash or
  // unresponsive mid-job. A loaded state (audio/score state is kept).
  | "transcriptionError"
  | "scoreReady"
  | "reviewing"
  | "exporting";

export const SCREEN_STATES: readonly ScreenState[] = [
  "empty",
  "openingAudio",
  "audioReady",
  "audioError",
  "sourceMissing",
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

/**
 * Whether the workspace chrome exists for this state (waveform strip and,
 * once loaded, transport/properties). EMPTY and the two import error
 * states show only the centered score-region surface (§3, §20);
 * OPENING_AUDIO already mounts the waveform strip so the loading line has
 * its final home (loading.openingAudio → waveform.loading).
 */
export function hasWorkspaceRegions(screen: ScreenState): boolean {
  return (
    screen !== "empty" && screen !== "audioError" && screen !== "sourceMissing"
  );
}

export function regionVisibility(screen: ScreenState): RegionVisibility {
  const context = hasWorkspaceRegions(screen);
  const loaded = context && screen !== "openingAudio";
  return {
    waveform: context,
    score: true,
    // The panel itself decides open/closed; EMPTY never mounts it (§3), and
    // it stays hidden while the file is still opening.
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
    // Audio-gated commands stay off while the file is still opening and in
    // the error states — nothing playable exists yet.
    hasAudio: hasWorkspaceRegions(screen) && screen !== "openingAudio",
    hasScore,
    isTranscribing: screen === "transcribing",
    reviewOpen: screen === "reviewing",
  };
  // [UI-040] transcriptionError: hasAudio=true (loaded), isTranscribing
  // =false → 採譜 stays reachable as the retry path; hasScore=false keeps
  // score/export commands off while the §20 error surface is up.
}
