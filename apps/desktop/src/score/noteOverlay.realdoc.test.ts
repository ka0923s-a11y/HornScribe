import { describe, expect, it } from "vitest";
import { waveformNoteOverlay } from "./noteOverlay";
// Real engine output captured from a 5 s C-major-scale run — guards
// the beat-fraction / tempo-map decoding against the actual payload
// shape (the unit tests all use synthetic docs).
import realDocRaw from "./fixtures/canonical_scale_doc.json?raw";

const real = JSON.parse(realDocRaw);

describe("waveformNoteOverlay vs real engine doc", () => {
  it("maps every note inside the 5s clip", () => {
    const notes = waveformNoteOverlay(real);
    expect(notes.length).toBe(8);
    for (const n of notes) {
      expect(Number.isFinite(n.startSec)).toBe(true);
      expect(n.endSec).toBeGreaterThan(n.startSec);
      expect(n.startSec).toBeLessThan(5.5);
    }
  });
});
