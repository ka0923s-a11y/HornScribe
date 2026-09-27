import { describe, expect, it } from "vitest";
import {
  makeRegionLabel,
  parseRegionLabels,
  regionLabelsFingerprint,
  serializeRegionLabels,
} from "./regionLabels";

describe("regionLabels (#12)", () => {
  it("makeRegionLabel trims, clamps length, and sorts endpoints", () => {
    const l = makeRegionLabel("  サビ  ", 30.5, 12.25);
    expect(l).not.toBeNull();
    expect(l!.label).toBe("サビ");
    expect(l!.startSec).toBe(12.25);
    expect(l!.endSec).toBe(30.5);
  });

  it("rejects empty names and empty/inverted-to-zero ranges", () => {
    expect(makeRegionLabel("", 0, 10)).toBeNull();
    expect(makeRegionLabel("   ", 0, 10)).toBeNull();
    expect(makeRegionLabel("x", 5, 5)).toBeNull();
    expect(makeRegionLabel("x", -3, -1)).toBeNull(); // clamped to zero-length
  });

  it("parseRegionLabels drops malformed rows and sorts by start", () => {
    const parsed = parseRegionLabels([
      { label: "サビ", startSec: 60, endSec: 90 },
      { label: "", startSec: 1, endSec: 2 },        // 名無し → 捨てる
      { label: "Aメロ", startSec: "x", endSec: 30 }, // 型違い → 捨てる
      "junk",
      null,
      { label: "Aメロ", startSec: 0, endSec: 30 },
    ]);
    expect(parsed.map((l) => l.label)).toEqual(["Aメロ", "サビ"]);
    expect(parsed[0].startSec).toBe(0);
  });

  it("parseRegionLabels returns [] for non-array input", () => {
    expect(parseRegionLabels(undefined)).toEqual([]);
    expect(parseRegionLabels(null)).toEqual([]);
    expect(parseRegionLabels({})).toEqual([]);
    expect(parseRegionLabels("x")).toEqual([]);
  });

  it("serialize/parse round-trips label + range (id is regenerated)", () => {
    const a = makeRegionLabel("Aメロ", 0, 30)!;
    const b = makeRegionLabel("サビ", 30, 60)!;
    const round = parseRegionLabels(serializeRegionLabels([a, b]));
    expect(round.map((l) => [l.label, l.startSec, l.endSec])).toEqual([
      ["Aメロ", 0, 30],
      ["サビ", 30, 60],
    ]);
  });

  it("fingerprint is order-insensitive over same content", () => {
    const a = makeRegionLabel("A", 0, 10)!;
    const b = makeRegionLabel("B", 10, 20)!;
    expect(regionLabelsFingerprint([a, b])).toBe(
      regionLabelsFingerprint([b, a]),
    );
    const c = makeRegionLabel("A", 0, 11)!;
    expect(regionLabelsFingerprint([a])).not.toBe(
      regionLabelsFingerprint([c]),
    );
  });
});
