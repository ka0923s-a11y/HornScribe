import { describe, expect, it } from "vitest";

import { scoreHasPolyphony } from "./polyphony";

const note = (startBeat: string, deleted = false) => ({
  startBeat,
  ...(deleted ? { deleted: true } : {}),
});

const doc = (parts: readonly { notes: unknown[] }[]) => ({
  content: { parts },
});

describe("scoreHasPolyphony (#123)", () => {
  it("null/garbage payloads are monophonic", () => {
    expect(scoreHasPolyphony(null)).toBe(false);
    expect(scoreHasPolyphony({})).toBe(false);
    expect(scoreHasPolyphony({ content: {} })).toBe(false);
    expect(scoreHasPolyphony(doc([]))).toBe(false);
  });

  it("a single monophonic part is not polyphonic", () => {
    expect(
      scoreHasPolyphony(
        doc([{ notes: [note("0/1"), note("1/1"), note("2/1")] }]),
      ),
    ).toBe(false);
  });

  it("same-onset live notes (a chord) count", () => {
    expect(
      scoreHasPolyphony(
        doc([{ notes: [note("0/1"), note("0/1"), note("1/1")] }]),
      ),
    ).toBe(true);
  });

  it("deleted chord members do not count — they render as rests", () => {
    expect(
      scoreHasPolyphony(
        doc([{ notes: [note("0/1"), note("0/1", true)] }]),
      ),
    ).toBe(false);
  });

  it("a second part with live notes counts", () => {
    expect(
      scoreHasPolyphony(
        doc([
          { notes: [note("0/1")] },
          { notes: [note("0/1")] },
        ]),
      ),
    ).toBe(true);
  });

  it("an all-deleted second part does not count", () => {
    expect(
      scoreHasPolyphony(
        doc([{ notes: [note("0/1")] }, { notes: [note("0/1", true)] }]),
      ),
    ).toBe(false);
  });
});
