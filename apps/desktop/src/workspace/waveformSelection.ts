import type { ScreenState } from "./screen";
import type { TranscriptionOptions } from "../import/types";
import type { SelectionRange } from "../import/selection";

/**
 * #353: the waveform band is playback/navigation state, not job
 * config. Before this split, a drag after transcription silently
 * rewrote TranscriptionOptions.range — the band and the job's input
 * range shared one state, which is why selection was simply disabled
 * outside audioReady.
 *
 * Ownership rule: a drag commits to waveformSelection ALWAYS; it
 * only feeds the transcription options on the import screen, where
 * selecting IS asking for a partial transcription. Post-score
 * selections never silently narrow the next retranscribe — #345 can
 * hang an explicit re-transcribe-this-range action off the same
 * generic band.
 */
export function optionsAfterWaveformSelect(
  screen: ScreenState,
  options: TranscriptionOptions,
  range: SelectionRange,
): TranscriptionOptions {
  if (screen !== "audioReady") return options;
  return {
    ...options,
    range: "selection",
    selectionStartSec: range.startSec,
    selectionEndSec: range.endSec,
  };
}

/** Clearing the band drops the implicit "selection" range option —
 *  an option already on "all" (or anything else) is left alone. */
export function optionsAfterWaveformClear(
  options: TranscriptionOptions,
): TranscriptionOptions {
  return options.range === "selection"
    ? { ...options, range: "all" }
    : options;
}