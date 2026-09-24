/**
 * #115: rhythm-edit helpers — the "n/d" beat fractions the canonical
 * payload uses, the ×2/÷2 duration ladder, and canonical-note lookup
 * inside a scoreDocument dict.
 */
import { describe, expect, it } from "vitest";
import {
  findCanonicalNote,
  formatFraction,
  parseFraction,
  scaleFraction,
} from "./rhythmEdits";

describe("parseFraction", () => {
  it("parses reduced and unreduced n/d strings", () => {
    expect(parseFraction("1/4")).toEqual({ num: 1, den: 4 });
    expect(parseFraction("2/8")).toEqual({ num: 1, den: 4 });
    expect(parseFraction("3/16")).toEqual({ num: 3, den: 16 });
  });

  it("rejects non-fractions and unsafe shapes", () => {
    expect(parseFraction("quarter")).toBeNull();
    expect(parseFraction("1:4")).toBeNull();
    expect(parseFraction("1/0")).toBeNull();
    expect(parseFraction(0.25)).toBeNull();
    expect(parseFraction(null)).toBeNull();
    expect(parseFraction("1/")).toBeNull();
  });
});

describe("scaleFraction", () => {
  it("doubles and halves across the duration ladder", () => {
    const quarter = { num: 1, den: 4 };
    expect(scaleFraction(quarter, 1)).toEqual({ num: 1, den: 2 });
    expect(scaleFraction(quarter, -1)).toEqual({ num: 1, den: 8 });
    expect(scaleFraction(quarter, 2)).toEqual({ num: 1, den: 1 });
    expect(scaleFraction(quarter, -2)).toEqual({ num: 1, den: 16 });
  });

  it("keeps odd numerators exact (3/8 → 3/4, 3/16)", () => {
    const dottedQuarter = { num: 3, den: 8 };
    expect(scaleFraction(dottedQuarter, 1)).toEqual({ num: 3, den: 4 });
    expect(scaleFraction(dottedQuarter, -1)).toEqual({ num: 3, den: 16 });
  });

  it("power 0 is the identity and results stay reduced", () => {
    const f = { num: 2, den: 8 };
    expect(scaleFraction(f, 0)).toEqual({ num: 1, den: 4 });
    expect(scaleFraction({ num: 1, den: 2 }, 1)).toEqual({ num: 1, den: 1 });
  });
});

describe("formatFraction", () => {
  it("round-trips through parseFraction", () => {
    const f = { num: 3, den: 8 };
    expect(formatFraction(f)).toBe("3/8");
    expect(parseFraction(formatFraction(f))).toEqual(f);
  });
});

describe("findCanonicalNote", () => {
  const scoreDocument = {
    projectId: "pj-test",
    revision: "rev-test",
    content: {
      parts: [
        {
          id: "part-1",
          notes: [
            {
              id: "sn-000001",
              pitchMidi: 60,
              startBeat: "0/1",
              durationBeats: "1/4",
            },
            {
              id: "sn-000002",
              pitchMidi: 64,
              startBeat: "1/4",
              durationBeats: "3/8",
            },
          ],
        },
      ],
    },
  };

  it("finds a note's timing by canonical id", () => {
    expect(findCanonicalNote(scoreDocument, "sn-000002")).toEqual({
      noteId: "sn-000002",
      startBeat: { num: 1, den: 4 },
      durationBeats: { num: 3, den: 8 },
      pitchMidi: 64,
    });
  });

  it("returns null for unknown ids and malformed payloads", () => {
    expect(findCanonicalNote(scoreDocument, "sn-999")).toBeNull();
    expect(findCanonicalNote(null, "sn-000001")).toBeNull();
    expect(findCanonicalNote({}, "sn-000001")).toBeNull();
    expect(findCanonicalNote({ content: {} }, "sn-000001")).toBeNull();
    expect(
      findCanonicalNote(
        { content: { parts: [{ notes: [{ id: "sn-1", startBeat: "x" }] }] } },
        "sn-1",
      ),
    ).toBeNull();
  });
});
