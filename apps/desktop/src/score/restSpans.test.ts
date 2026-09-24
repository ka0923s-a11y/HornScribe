/**
 * Rest-atom ordinal mapping tests (#163). The export numbers every
 * rest <note> element hs-rest-1,2,3,... in document order — one glyph
 * per rest ATOM — so walking the canonical payload's atoms in part
 * order must recover (partId, atom start, atom duration) for any
 * clicked ordinal.
 */
import { describe, expect, it } from "vitest";
import {
  nextScoreNoteId,
  pitchBefore,
  restAtomAtOrdinal,
  restOrdinalOf,
} from "./restSpans";

function atom(durationBeats: string): Record<string, unknown> {
  return {
    durationBeats,
    symbol: "rest",
    dots: 0,
    tuplet: null,
    tupletGroupStart: false,
    tieToNext: false,
  };
}

function rest(
  startBeat: string,
  durations: string[],
): Record<string, unknown> {
  return { startBeat, atoms: durations.map(atom) };
}

function note(
  id: string,
  startBeat: string,
  durationBeats: string,
  pitchMidi: number,
): Record<string, unknown> {
  return {
    id,
    sourceEventIds: [],
    startBeat,
    durationBeats,
    pitchMidi,
  };
}

function doc(parts: Record<string, unknown>[]): unknown {
  return { content: { parts } };
}

describe("restOrdinalOf", () => {
  it("parses hs-rest-* export ids", () => {
    expect(restOrdinalOf("hs-rest-000001")).toBe(1);
    expect(restOrdinalOf("hs-rest-000042")).toBe(42);
  });

  it("rejects non-rest and malformed ids", () => {
    expect(restOrdinalOf("hs-sn-000001")).toBeNull();
    expect(restOrdinalOf("hs-rest-1")).toBeNull();
    expect(restOrdinalOf("hs-rest-000000")).toBeNull();
    expect(restOrdinalOf("rest-000001")).toBeNull();
  });
});

describe("restAtomAtOrdinal", () => {
  const twoPart = doc([
    {
      id: "P1",
      rests: [
        rest("0/1", ["1/1", "1/2"]),
        rest("4/1", ["1/1"]),
      ],
      notes: [],
    },
    {
      id: "P2",
      rests: [rest("0/1", ["2/1"])],
      notes: [],
    },
  ]);

  it("walks atoms in document order across parts", () => {
    // P1 span 0: atoms 1/1 @0, 1/2 @1 -> ordinals 1,2.
    expect(restAtomAtOrdinal(twoPart, 1)).toEqual({
      partId: "P1",
      startBeat: { num: 0, den: 1 },
      durationBeats: { num: 1, den: 1 },
    });
    expect(restAtomAtOrdinal(twoPart, 2)).toEqual({
      partId: "P1",
      startBeat: { num: 1, den: 1 },
      durationBeats: { num: 1, den: 2 },
    });
    // P1 span 4 -> ordinal 3; P2's first atom -> ordinal 4.
    expect(restAtomAtOrdinal(twoPart, 3)).toEqual({
      partId: "P1",
      startBeat: { num: 4, den: 1 },
      durationBeats: { num: 1, den: 1 },
    });
    expect(restAtomAtOrdinal(twoPart, 4)).toEqual({
      partId: "P2",
      startBeat: { num: 0, den: 1 },
      durationBeats: { num: 2, den: 1 },
    });
  });

  it("accumulates atom onsets inside a span", () => {
    const d = doc([
      { id: "P1", rests: [rest("2/1", ["1/4", "1/4", "1/2"])], notes: [] },
    ]);
    expect(restAtomAtOrdinal(d, 3)).toEqual({
      partId: "P1",
      startBeat: { num: 5, den: 2 },
      durationBeats: { num: 1, den: 2 },
    });
  });

  it("returns null past the last atom or on a malformed payload", () => {
    expect(restAtomAtOrdinal(twoPart, 5)).toBeNull();
    expect(restAtomAtOrdinal(null, 1)).toBeNull();
    expect(restAtomAtOrdinal({}, 1)).toBeNull();
    expect(restAtomAtOrdinal(doc([]), 1)).toBeNull();
  });
});

describe("nextScoreNoteId", () => {
  it("continues the highest sn-* ordinal across parts", () => {
    const d = doc([
      { id: "P1", notes: [note("sn-000003", "0/1", "1/1", 60)] },
      { id: "P2", notes: [note("sn-000007", "0/1", "1/1", 62)] },
    ]);
    expect(nextScoreNoteId(d)).toBe("sn-000008");
  });

  it("starts at sn-000000 when no notes exist", () => {
    expect(nextScoreNoteId(doc([{ id: "P1", notes: [] }]))).toBe(
      "sn-000000",
    );
    expect(nextScoreNoteId(null)).toBe("sn-000000");
  });

  it("ignores non-sn ids", () => {
    const d = doc([
      { id: "P1", notes: [note("n-9", "0/1", "1/1", 60)] },
    ]);
    expect(nextScoreNoteId(d)).toBe("sn-000000");
  });
});

describe("pitchBefore", () => {
  const d = doc([
    {
      id: "P1",
      notes: [
        note("sn-000001", "0/1", "1/1", 64),
        note("sn-000002", "2/1", "1/1", 67),
      ],
    },
    { id: "P2", notes: [note("sn-000003", "0/1", "4/1", 48)] },
  ]);

  it("returns the nearest preceding note's pitch in the same part", () => {
    // Rest at 4/1 in P1: the G4 ending at 3 is the nearest.
    expect(pitchBefore(d, "P1", { num: 4, den: 1 })).toBe(67);
    // Rest at 1/1: the E4 ending exactly at 1 counts ("at or before").
    expect(pitchBefore(d, "P1", { num: 1, den: 1 })).toBe(64);
  });

  it("does not leak pitches across parts", () => {
    // P2's single note ends at 4 — a rest at 4/1 in P2 sees it.
    expect(pitchBefore(d, "P2", { num: 4, den: 1 })).toBe(48);
    // A rest at 0 in P2 has no predecessor in P2 -> C4 fallback.
    expect(pitchBefore(d, "P2", { num: 0, den: 1 })).toBe(60);
  });

  it("falls back to C4 with no usable predecessor", () => {
    expect(pitchBefore(d, "P1", { num: 0, den: 1 })).toBe(60);
    expect(pitchBefore(doc([]), "P1", { num: 4, den: 1 })).toBe(60);
    expect(pitchBefore(null, "P1", { num: 4, den: 1 })).toBe(60);
  });
});
