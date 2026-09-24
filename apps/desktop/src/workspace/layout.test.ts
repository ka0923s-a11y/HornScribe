// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  readScoreSessionView,
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
