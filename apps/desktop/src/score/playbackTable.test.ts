/**
 * Playback-table tests (UI-030). The table precomputes score-ms → sounding
 * canonical notes from Verovio timemap output so the frame pump never calls
 * into WASM (UI-005 finding).
 */
import { describe, expect, it } from "vitest";
import type { VerovioTimemapEntry } from "verovio/esm";
import {
  activeCanonicalsAt,
  buildPlaybackTable,
  canonicalsInRange,
  nearestCanonicalAt,
  segmentAt,
} from "./playbackTable";

/** Fixture-shaped timemap: a melody + a rest gap + a tied note chain. */
const TIMEMAP: VerovioTimemapEntry[] = [
  { qstamp: 0, tstamp: 0, on: ["hs-sn-000001"], off: [] },
  { qstamp: 1, tstamp: 500, on: ["hs-sn-000002"], off: ["hs-sn-000001"] },
  { qstamp: 2, tstamp: 1000, on: ["hs-sn-000003"], off: ["hs-sn-000002"] },
  // rest gap 1500..2000 — nothing sounding
  { qstamp: 3, tstamp: 1500, on: [], off: ["hs-sn-000003"] },
  { qstamp: 4, tstamp: 2000, on: ["hs-sn-000004"], off: [] },
  // tie: fragment 2 takes over while fragment 1 ends — the canonical note
  // keeps sounding across the fragment boundary.
  { qstamp: 5, tstamp: 2500, on: ["hs-sn-000004-2"], off: ["hs-sn-000004"] },
  { qstamp: 6, tstamp: 3000, on: [], off: ["hs-sn-000004-2"] },
];

const table = buildPlaybackTable(TIMEMAP);

describe("buildPlaybackTable", () => {
  it("computes the document duration from the last tstamp", () => {
    expect(table.durationMs).toBe(3000);
  });

  it("maps export ids to their onset ms", () => {
    expect(table.onsetMsByExportId.get("hs-sn-000002")).toBe(500);
    expect(table.onsetMsByExportId.get("hs-sn-000004-2")).toBe(2500);
  });

  it("groups fragments under one canonical id with the earliest onset", () => {
    expect(table.exportIdsByCanonical.get("sn-000004")).toEqual([
      "hs-sn-000004",
      "hs-sn-000004-2",
    ]);
    expect(table.onsetMsByCanonical.get("sn-000004")).toBe(2000);
  });
});

describe("segmentAt", () => {
  it("returns the sounding segment (half-open bounds)", () => {
    expect(segmentAt(table, 0)?.canonicalIds.has("sn-000001")).toBe(true);
    expect(segmentAt(table, 499)?.canonicalIds.has("sn-000001")).toBe(true);
    expect(segmentAt(table, 500)?.canonicalIds.has("sn-000002")).toBe(true);
  });

  it("keeps a tied note sounding across its fragment boundary", () => {
    expect(segmentAt(table, 2400)?.canonicalIds.has("sn-000004")).toBe(true);
    expect(segmentAt(table, 2600)?.canonicalIds.has("sn-000004")).toBe(true);
  });

  it("returns null in rest gaps and after the end", () => {
    expect(segmentAt(table, 1700)).toBeNull();
    expect(segmentAt(table, 3000)).toBeNull();
    expect(activeCanonicalsAt(table, 1700).size).toBe(0);
  });
});

describe("canonicalsInRange", () => {
  it("returns every canonical overlapping the half-open range", () => {
    const set = canonicalsInRange(table, 400, 2100);
    expect(set.has("sn-000001")).toBe(true);
    expect(set.has("sn-000002")).toBe(true);
    expect(set.has("sn-000003")).toBe(true);
    expect(set.has("sn-000004")).toBe(true);
  });

  it("excludes notes that end exactly at the range start", () => {
    const set = canonicalsInRange(table, 500, 600);
    expect(set.has("sn-000001")).toBe(false);
    expect(set.has("sn-000002")).toBe(true);
  });

  it("returns an empty set for empty/inverted ranges", () => {
    expect(canonicalsInRange(table, 100, 100).size).toBe(0);
    expect(canonicalsInRange(table, 200, 100).size).toBe(0);
  });
});

describe("nearestCanonicalAt", () => {
  it("returns the earliest-onset sounding canonical", () => {
    expect(nearestCanonicalAt(table, 100)).toBe("sn-000001");
  });

  it("resolves rest gaps to the nearest onset either side", () => {
    // Gap 1500..2000: sn-000004's onset (2000) is closer than sn-000003's
    // (1000) everywhere inside the gap.
    expect(nearestCanonicalAt(table, 1900)).toBe("sn-000004");
    // Past the document end the scan falls back to the latest onset.
    expect(nearestCanonicalAt(table, 3100)).toBe("sn-000004");
  });
});
