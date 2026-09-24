import { describe, expect, it } from "vitest";
import {
  centerViewAt,
  clientXInView,
  clientXToSeconds,
  clampView,
  fullView,
  isFullView,
  normalizeSelection,
  panView,
  selectionBand,
  selectionBandInView,
  zoomView,
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

describe("view window (#113, spec 8/15 zoom)", () => {
  it("fullView spans the clip and isFullView detects it", () => {
    const v = fullView(60);
    expect(v).toEqual({ startSec: 0, endSec: 60 });
    expect(isFullView(v, 60)).toBe(true);
    expect(isFullView({ startSec: 10, endSec: 60 }, 60)).toBe(false);
  });

  it("zoomView shrinks around the anchor and clamps to the clip", () => {
    const full = fullView(60);
    const z = zoomView(full, 30, 0.5, 60);
    expect(z.endSec - z.startSec).toBeCloseTo(30);
    // anchor stays at the same fractional position (0.5)
    expect((30 - z.startSec) / (z.endSec - z.startSec)).toBeCloseTo(0.5);
    // zooming out past the clip clamps back to full
    expect(isFullView(zoomView(z, 30, 4, 60), 60)).toBe(true);
  });

  it("panView shifts the window without changing its span", () => {
    const v = panView({ startSec: 10, endSec: 20 }, 5, 60);
    expect(v).toEqual({ startSec: 15, endSec: 25 });
    // clamped at both edges
    expect(panView(v, -100, 60)).toEqual({ startSec: 0, endSec: 10 });
    expect(panView(v, 100, 60)).toEqual({ startSec: 50, endSec: 60 });
  });

  it("clientXInView maps inside the zoomed window", () => {
    const view = { startSec: 20, endSec: 40 };
    expect(clientXInView(0, 0, 1000, view)).toBe(20);
    expect(clientXInView(1000, 0, 1000, view)).toBe(40);
    expect(clientXInView(500, 0, 1000, view)).toBe(30);
    expect(clientXInView(-50, 0, 1000, view)).toBe(20);
  });

  it("selectionBandInView clips to the window and drops misses", () => {
    const view = { startSec: 20, endSec: 40 };
    expect(
      selectionBandInView({ startSec: 30, endSec: 50 }, view),
    ).toEqual({ left: 0.5, width: 0.5 });
    expect(
      selectionBandInView({ startSec: 0, endSec: 10 }, view),
    ).toBeNull();
    expect(selectionBandInView(null, view)).toBeNull();
  });

  it("clampView preserves the span at the edges", () => {
    expect(clampView({ startSec: -5, endSec: 15 }, 60)).toEqual({
      startSec: 0,
      endSec: 20,
    });
    expect(clampView({ startSec: 55, endSec: 75 }, 60)).toEqual({
      startSec: 40,
      endSec: 60,
    });
  });

  it("centerViewAt centres the window and clamps at the edges (#116)", () => {
    const v = centerViewAt({ startSec: 10, endSec: 20 }, 40, 60);
    expect(v).toEqual({ startSec: 35, endSec: 45 });
    // Centring near an edge clamps instead of overshooting.
    expect(centerViewAt({ startSec: 10, endSec: 20 }, 2, 60)).toEqual({
      startSec: 0,
      endSec: 10,
    });
    expect(centerViewAt({ startSec: 10, endSec: 20 }, 59, 60)).toEqual({
      startSec: 50,
      endSec: 60,
    });
    // A full view stays full — the minimap seeks instead of panning.
    expect(centerViewAt({ startSec: 0, endSec: 60 }, 30, 60)).toEqual({
      startSec: 0,
      endSec: 60,
    });
  });
});
