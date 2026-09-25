// @vitest-environment node
// #353: the waveform band owns playback/navigation only — a drag
// feeds TranscriptionOptions solely on the import screen, where
// selecting IS asking for a partial transcription. Post-score
// selections never touch the next job's range.
import { describe, expect, it } from "vitest";
import {
  optionsAfterWaveformClear,
  optionsAfterWaveformSelect,
} from "./waveformSelection";
import { DEFAULT_TRANSCRIPTION_OPTIONS } from "../import/types";

const RANGE = { startSec: 10.5, endSec: 22.25 };

describe("optionsAfterWaveformSelect (#353)", () => {
  it("audioReady selects feed the job's range option (workflow kept)", () => {
    const next = optionsAfterWaveformSelect(
      "audioReady",
      DEFAULT_TRANSCRIPTION_OPTIONS,
      RANGE,
    );
    expect(next.range).toBe("selection");
    expect(next.selectionStartSec).toBe(10.5);
    expect(next.selectionEndSec).toBe(22.25);
  });

  it.each(["scoreReady", "reviewing", "transcribing"] as const)(
    "%s selections never touch the transcription options",
    (screen) => {
      const next = optionsAfterWaveformSelect(
        screen,
        DEFAULT_TRANSCRIPTION_OPTIONS,
        RANGE,
      );
      expect(next).toBe(DEFAULT_TRANSCRIPTION_OPTIONS);
    },
  );

  it("a post-score selection leaves a stale selection option alone too", () => {
    const stale = {
      ...DEFAULT_TRANSCRIPTION_OPTIONS,
      range: "selection" as const,
      selectionStartSec: 1,
      selectionEndSec: 2,
    };
    // The band is independent now — dragging on the score does not
    // overwrite the option a previous import left behind.
    expect(optionsAfterWaveformSelect("scoreReady", stale, RANGE)).toBe(
      stale,
    );
  });
});

describe("optionsAfterWaveformClear (#353)", () => {
  it("dropping the band resets an implicit selection range to all", () => {
    const selected = {
      ...DEFAULT_TRANSCRIPTION_OPTIONS,
      range: "selection" as const,
      selectionStartSec: 1,
      selectionEndSec: 2,
    };
    expect(optionsAfterWaveformClear(selected).range).toBe("all");
  });

  it("leaves non-selection options untouched", () => {
    expect(optionsAfterWaveformClear(DEFAULT_TRANSCRIPTION_OPTIONS)).toBe(
      DEFAULT_TRANSCRIPTION_OPTIONS,
    );
  });
});