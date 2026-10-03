/**
 * #59: queue-entry params summary — every emitted key is a user-pinned
 * setting (defaults never reach params), so the fragment list must be
 * both complete and honest about what it shows.
 */
import { describe, expect, it } from "vitest";
import { queueParamSummary } from "./paramSummary";
import { ja } from "../strings/ja";
import { formatTimecode } from "../import/format";

describe("queueParamSummary (#59)", () => {
  it("returns an empty string for all-default params", () => {
    expect(queueParamSummary({})).toBe("");
    // audioPath/displayName are identity, not options — ignored.
    expect(
      queueParamSummary({ audioPath: "C:\\a.wav", displayName: "a.wav" }),
    ).toBe("");
  });

  it("renders the selection range as timecodes", () => {
    const s = queueParamSummary({
      range: "selection",
      selectionStartSec: 83,
      selectionEndSec: 165,
    });
    expect(s).toBe(
      ja.queue.paramsRange(formatTimecode(83), formatTimecode(165)),
    );
  });

  it("lists pinned options in a stable order separated by ・", () => {
    const s = queueParamSummary({
      range: "selection",
      selectionStartSec: 0,
      selectionEndSec: 30,
      texture: "voices",
      maxVoices: 4,
      backend: "basicPitch",
      vocalIsolation: true,
      tempoBpm: 120,
      meter: "3/4",
      keyHint: "Ebm",
      minDuration: "32",
      triplets: "none",
      simplicity: "detailed",
    });
    const parts = s.split(ja.queue.paramSep);
    expect(parts).toEqual([
      ja.queue.paramsRange(formatTimecode(0), formatTimecode(30)),
      ja.queue.paramsTexture.voices,
      ja.queue.paramsMaxVoices(4),
      "Basic Pitch",
      ja.queue.paramsVocalIsolation,
      ja.queue.paramsTempo(120),
      "3/4",
      ja.queue.paramsKey("Ebm"),
      ja.import.audioOptions.minDuration32,
      ja.queue.paramsTriplets.none,
      ja.queue.paramsSimplicity.detailed,
    ]);
  });

  it("falls back to the raw value for unknown enum keys", () => {
    expect(queueParamSummary({ texture: "future-texture" })).toBe(
      "future-texture",
    );
    expect(queueParamSummary({ minDuration: "64" })).toBe("64");
  });

  it("#181: precision tier echoes only under vocal isolation", () => {
    const s = queueParamSummary({
      vocalIsolation: true,
      vocalIsolationQuality: "precision",
    });
    expect(s).toBe(
      ja.queue.paramsVocalIsolation +
        ja.queue.paramSep +
        ja.queue.paramsVocalIsolationPrecision,
    );
    // Standard tier and a bare quality param echo nothing.
    expect(
      queueParamSummary({
        vocalIsolation: true,
        vocalIsolationQuality: "standard",
      }),
    ).toBe(ja.queue.paramsVocalIsolation);
    expect(
      queueParamSummary({ vocalIsolationQuality: "precision" }),
    ).toBe("");
  });
});
