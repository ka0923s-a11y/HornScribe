// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  readWaveformView,
  readScoreSessionView,
  writeWaveformView,
  writeScoreSessionView,
} from "./layout";

/* §26: score view session restore — zoom % and view mode persist in
 * the shared layout record. */

const KEY = "hornscribe.layout.v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("score session view", () => {
  it("returns nulls when nothing is stored", () => {
    expect(readScoreSessionView()).toEqual({
      zoomPct: null,
      viewMode: null,
    });
  });

  it("round-trips zoom and view mode", () => {
    writeScoreSessionView({ zoomPct: 150 });
    writeScoreSessionView({ viewMode: "page" });
    expect(readScoreSessionView()).toEqual({
      zoomPct: 150,
      viewMode: "page",
    });
  });

  it("preserves other layout fields", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ propertiesWidth: 320, propertiesOpen: true }),
    );
    writeScoreSessionView({ zoomPct: 75 });
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    expect(raw.propertiesWidth).toBe(320);
    expect(raw.propertiesOpen).toBe(true);
    expect(raw.scoreZoomPct).toBe(75);
  });

  it("ignores corrupt/foreign values", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ scoreZoomPct: "wide", scoreViewMode: "grid" }),
    );
    expect(readScoreSessionView()).toEqual({
      zoomPct: null,
      viewMode: null,
    });
    window.localStorage.setItem(KEY, "not json");
    expect(readScoreSessionView()).toEqual({
      zoomPct: null,
      viewMode: null,
    });
  });
});

describe("waveform view persistence", () => {
  it("returns null when nothing is stored", () => {
    expect(readWaveformView("take.wav", 120)).toBeNull();
  });

  it("round-trips a zoom window per source", () => {
    writeWaveformView("take.wav", 120, { startSec: 10, endSec: 30 });
    expect(readWaveformView("take.wav", 120)).toEqual({
      startSec: 10,
      endSec: 30,
    });
    // A different clip does not inherit the window.
    expect(readWaveformView("other.wav", 120)).toBeNull();
    expect(readWaveformView("take.wav", 60)).toBeNull();
  });

  it("clears the entry on a full view", () => {
    writeWaveformView("take.wav", 120, { startSec: 10, endSec: 30 });
    writeWaveformView("take.wav", 120, null);
    expect(readWaveformView("take.wav", 120)).toBeNull();
  });

  it("rejects ranges outside the clip", () => {
    writeWaveformView("take.wav", 120, { startSec: 10, endSec: 30 });
    // Same file name, shorter clip -> stored window no longer fits.
    expect(readWaveformView("take.wav", 15)).toBeNull();
  });

  it("clamps the end to the clip duration", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        waveformViews: { "take.wav|120.000": { startSec: 10, endSec: 200 } },
      }),
    );
    expect(readWaveformView("take.wav", 120)).toEqual({
      startSec: 10,
      endSec: 120,
    });
  });

  it("caps stored clips and keeps the freshest", () => {
    for (let i = 0; i < 20; i += 1) {
      writeWaveformView("clip-" + i + ".wav", 60, { startSec: 1, endSec: 2 });
    }
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    expect(Object.keys(raw.waveformViews)).toHaveLength(16);
    expect(readWaveformView("clip-19.wav", 60)).not.toBeNull();
    expect(readWaveformView("clip-0.wav", 60)).toBeNull();
  });
});
