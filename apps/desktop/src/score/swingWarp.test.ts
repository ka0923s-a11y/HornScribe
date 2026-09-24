/**
 * Swing-warp tests (#156). Verovio's timemap ignores <sound><swing>, so
 * buildSwingWarp re-derives the written->sounding map from the canonical
 * payload (swingFeel + tempoMap + head meter) and shifts each beat's
 * second half onto the detected phase.
 */
import { describe, expect, it } from "vitest";
import type { VerovioTimemapEntry } from "verovio/esm";
import { buildPlaybackTable } from "./playbackTable";
import { buildSwingWarp } from "./swingWarp";

function doc(overrides: Record<string, unknown> = {}): unknown {
  return {
    content: {
      swingFeel: "2/3",
      tempoMap: [{ startBeat: "0/1", bpm: 120 }],
      timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
      parts: [],
      ...overrides,
    },
  };
}

describe("buildSwingWarp", () => {
  it("returns null without a usable swing feel", () => {
    expect(buildSwingWarp(null)).toBeNull();
    expect(buildSwingWarp({})).toBeNull();
    expect(buildSwingWarp(doc({ swingFeel: undefined }))).toBeNull();
    expect(buildSwingWarp(doc({ swingFeel: "0/1" }))).toBeNull();
    expect(buildSwingWarp(doc({ swingFeel: "1/1" }))).toBeNull();
    expect(buildSwingWarp(doc({ swingFeel: "junk" }))).toBeNull();
  });

  it("returns null when the tempo map or meter is malformed", () => {
    expect(buildSwingWarp(doc({ tempoMap: [] }))).toBeNull();
    expect(
      buildSwingWarp(doc({ tempoMap: [{ startBeat: "0/1", bpm: 0 }] })),
    ).toBeNull();
    expect(
      buildSwingWarp(doc({ timeSignature: { beatsPerMeasure: 0, beatUnit: 4 } })),
    ).toBeNull();
  });

  it("keeps beat onsets and measure ends fixed at 4/4 120bpm", () => {
    const warp = buildSwingWarp(doc());
    expect(warp).not.toBeNull();
    // 4/4 at 120bpm: one beat = 500ms, one measure = 2000ms.
    expect(warp?.(0)).toBe(0);
    expect(warp?.(500)).toBe(500);
    expect(warp?.(2000)).toBe(2000);
  });

  it("pulls the written offbeat to the detected phase", () => {
    const warp = buildSwingWarp(doc());
    // Written beat 1/2 (250ms) sounds at phase 2/3 -> 333.33ms.
    expect(warp?.(250)).toBeCloseTo((2 / 3) * 500, 6);
    // Written 3/4 (375ms) sounds at p + (3/4-1/2)*2*(1-p) = 5/6.
    expect(warp?.(375)).toBeCloseTo((5 / 6) * 500, 6);
    // Second measure behaves identically (phase is per-beat).
    expect(warp?.(2250)).toBeCloseTo(2000 + (2 / 3) * 500, 6);
  });

  it("honours a mid-piece tempo change", () => {
    const warp = buildSwingWarp(
      doc({
        tempoMap: [
          { startBeat: "0/1", bpm: 120 },
          { startBeat: "4/1", bpm: 60 },
        ],
      }),
    );
    // First four beats at 120bpm -> 2000ms; then 60bpm -> 1000ms/beat.
    expect(warp?.(2000)).toBe(2000);
    expect(warp?.(3000)).toBe(3000);
    // Offbeat inside the slow segment: beat 4.5 written = 2500ms,
    // sounds at 2000 + (2/3)*1000.
    expect(warp?.(2500)).toBeCloseTo(2000 + (2 / 3) * 1000, 6);
  });

  it("scales the beat for compound meters (6/8)", () => {
    const warp = buildSwingWarp(
      doc({
        tempoMap: [{ startBeat: "0/1", bpm: 60 }],
        timeSignature: { beatsPerMeasure: 6, beatUnit: 8 },
      }),
    );
    // 6/8 dotted-quarter=60: primary beat = 1000ms, payload beat
    // (eighth) = 1000/3 ms.
    const eighth = 1000 / 3;
    expect(warp?.(eighth)).toBeCloseTo(eighth, 6);
    expect(warp?.(eighth / 2)).toBeCloseTo((2 / 3) * eighth, 6);
    expect(warp?.(6 * eighth)).toBeCloseTo(6 * eighth, 6);
  });

  it("warps a playback table's onsets and duration", () => {
    const timemap: VerovioTimemapEntry[] = [
      { qstamp: 0, tstamp: 0, on: ["hs-sn-000001"], off: [] },
      { qstamp: 0.5, tstamp: 250, on: ["hs-sn-000002"], off: ["hs-sn-000001"] },
      { qstamp: 1, tstamp: 500, on: ["hs-sn-000003"], off: ["hs-sn-000002"] },
      { qstamp: 2, tstamp: 1000, on: [], off: ["hs-sn-000003"] },
    ];
    const warp = buildSwingWarp(doc());
    const table = buildPlaybackTable(timemap, warp ?? undefined);
    // The offbeat onset moved to the swung position; beat onsets and
    // the total duration are unchanged.
    expect(table.onsetMsByExportId.get("hs-sn-000002")).toBeCloseTo(
      (2 / 3) * 500,
      6,
    );
    expect(table.onsetMsByExportId.get("hs-sn-000003")).toBe(500);
    expect(table.durationMs).toBe(1000);
  });
});
