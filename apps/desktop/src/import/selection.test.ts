import { describe, expect, it } from "vitest";
import {
  clientXToSeconds,
  normalizeSelection,
  selectionBand,
} from "./selection";

describe("clientXToSeconds", () => {
  it("maps the strip's left/right edges to 0/duration", () => {
    expect(clientXToSeconds(0, 0, 1000, 60)).toBe(0);
    expect(clientXToSeconds(1000, 0, 1000, 60)).toBe(60);
    expect(clientXToSeconds(500, 0, 1000, 60)).toBe(30);
  });

  it("clamps outside the strip", () => {
    expect(clientXToSeconds(-50, 0, 1000, 60)).toBe(0);
    expect(clientXToSeconds(2000, 0, 1000, 60)).toBe(60);
  });

  it("respects a non-zero rect origin", () => {
    expect(clientXToSeconds(300, 100, 400, 40)).toBe(20);
  });

  it("returns 0 for degenerate geometry", () => {
    expect(clientXToSeconds(10, 0, 0, 60)).toBe(0);
    expect(clientXToSeconds(10, 0, 100, 0)).toBe(0);
  });
});

describe("normalizeSelection", () => {
  it("orders a backwards drag", () => {
    expect(normalizeSelection(30, 10, 60)).toEqual({
      startSec: 10,
      endSec: 30,
    });
  });

  it("clamps to the clip", () => {
    expect(normalizeSelection(-5, 100, 60)).toEqual({
      startSec: 0,
      endSec: 60,
    });
  });

  it("keeps a zero-length range (collapsed band)", () => {
    expect(normalizeSelection(20, 20, 60)).toEqual({
      startSec: 20,
      endSec: 20,
    });
  });
});

describe("selectionBand", () => {
  it("returns fractional edges", () => {
    expect(selectionBand({ startSec: 15, endSec: 45 }, 60)).toEqual({
      left: 0.25,
      width: 0.5,
    });
  });

  it("returns null for empty or missing ranges", () => {
    expect(selectionBand(null, 60)).toBeNull();
    expect(selectionBand({ startSec: 30, endSec: 30 }, 60)).toBeNull();
    const inverted = selectionBand({ startSec: 40, endSec: 30 }, 60);
    expect(inverted?.left).toBeCloseTo(0.5);
    expect(inverted?.width).toBeCloseTo(1 / 6);
    expect(selectionBand({ startSec: 0, endSec: 10 }, 0)).toBeNull();
  });
});
