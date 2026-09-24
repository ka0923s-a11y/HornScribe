/**
 * velocityByCanonicalId (#168): the audition carries the detected
 * dynamics. Velocity lives on the canonical payload's notes, not on the
 * MusicXML ParsedNote view, so the synth reads it from canonical truth.
 */
import { describe, expect, it } from "vitest";
import { velocityByCanonicalId } from "./playbackSynth";
import { bendsByCanonicalId } from "./playbackSynth";
import { buildScheduledNotes } from "./playbackSynth";
import type { PlaybackTable } from "./playbackTable";
import type { ParsedNote } from "./scoreDoc";

function doc(parts: Record<string, unknown>[]): unknown {
  return { content: { parts } };
}

/* ---- #245: one musical attack = one ScheduledNote ---- */

function seg(
  startMs: number,
  endMs: number,
  ids: string[],
): PlaybackTable["segments"][number] {
  return {
    startMs,
    endMs,
    exportIds: ids.map((id) => `hs-${id}`),
    canonicalIds: new Set(ids),
  };
}

function table(segments: PlaybackTable["segments"]): PlaybackTable {
  return {
    segments,
    durationMs: segments.at(-1)?.endMs ?? 0,
    onsetMsByExportId: new Map(),
    onsetMsByCanonical: new Map(),
    exportIdsByCanonical: new Map(),
  };
}

function note(step: string, octave: number): ParsedNote {
  return {
    exportId: "hs-x",
    canonicalId: "sn-x",
    isRest: false,
    chord: false,
    measure: 1,
    step,
    octave,
    dots: 0,
    tied: false,
  };
}

describe("buildScheduledNotes (#245)", () => {
  it("a held note is not re-attacked at another voice's onset", () => {
    const t = table([
      seg(0, 1000, ["sn-1"]),
      seg(1000, 2000, ["sn-1", "sn-2"]),
    ]);
    const notes = buildScheduledNotes(
      t,
      new Map([
        ["sn-1", [note("C", 4)]],
        ["sn-2", [note("E", 4)]],
      ]),
    );
    const held = notes.filter((n) => n.startMs === 0);
    expect(held).toHaveLength(1);
    expect(held[0].endMs).toBe(2000);
    expect(notes).toHaveLength(2);
  });

  it("chord members attack once each at the same onset", () => {
    const t = table([seg(0, 500, ["sn-1", "sn-2"])]);
    const notes = buildScheduledNotes(
      t,
      new Map([
        ["sn-1", [note("C", 4)]],
        ["sn-2", [note("G", 4)]],
      ]),
    );
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.startMs === 0 && n.endMs === 500)).toBe(true);
  });

  it("a tied chain (multiple fragments) is one attack, not many", () => {
    const t = table([
      seg(0, 500, ["sn-1"]),
      seg(500, 1000, ["sn-1"]),
      seg(1000, 1500, ["sn-1"]),
    ]);
    const notes = buildScheduledNotes(
      t,
      // Two MusicXML fragments for one canonical note (barline split).
      new Map([["sn-1", [note("C", 4), note("C", 4)]]]),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].endMs).toBe(1500);
  });

  it("a repeated note separated by a rest attacks twice", () => {
    const t = table([
      seg(0, 500, ["sn-1"]),
      seg(500, 1000, []),
      seg(1000, 1500, ["sn-1"]),
    ]);
    const notes = buildScheduledNotes(t, new Map([["sn-1", [note("C", 4)]]]));
    expect(notes).toHaveLength(2);
    expect(notes[0].endMs).toBe(500);
    expect(notes[1].startMs).toBe(1000);
  });
});

describe("velocityByCanonicalId", () => {
describe("bendsByCanonicalId", () => {
  it("maps each canonical note id to its normalized bend curve (#174)", () => {
    const d = doc([
      {
        id: "P1",
        notes: [
          {
            id: "sn-000001",
            pitchBends: [
              { timeSec: 0, bendSemitones: 0 },
              { timeSec: 0.5, bendSemitones: 0.5 },
              { timeSec: 1, bendSemitones: 0 },
            ],
          },
          { id: "sn-000002" }, // no bends
        ],
      },
    ]);
    const m = bendsByCanonicalId(d);
    expect(m.get("sn-000001")).toEqual([
      { pos: 0, semis: 0 },
      { pos: 0.5, semis: 0.5 },
      { pos: 1, semis: 0 },
    ]);
    expect(m.has("sn-000002")).toBe(false);
  });

  it("skips malformed points and payloads", () => {
    const d = doc([
      {
        id: "P1",
        notes: [
          { id: "sn-000001", pitchBends: [{ timeSec: "x" }] },
          { id: "sn-000002", pitchBends: "nope" },
        ],
      },
    ]);
    const m = bendsByCanonicalId(d);
    expect(m.size).toBe(0);
    expect(bendsByCanonicalId(null).size).toBe(0);
    expect(bendsByCanonicalId({}).size).toBe(0);
    expect(bendsByCanonicalId(doc([])).size).toBe(0);
  });
});

  it("maps each canonical note id to its velocity", () => {
    const d = doc([
      {
        id: "P1",
        notes: [
          { id: "sn-000001", velocity: 96 },
          { id: "sn-000002", velocity: 40 },
        ],
      },
      { id: "P2", notes: [{ id: "sn-000007", velocity: 110 }] },
    ]);
    const m = velocityByCanonicalId(d);
    expect(m.get("sn-000001")).toBe(96);
    expect(m.get("sn-000002")).toBe(40);
    expect(m.get("sn-000007")).toBe(110);
  });

  it("skips notes without a numeric velocity and malformed payloads", () => {
    const d = doc([
      {
        id: "P1",
        notes: [
          { id: "sn-000001" }, // no velocity
          { id: "sn-000002", velocity: "loud" }, // wrong type
          { velocity: 90 }, // no id
        ],
      },
    ]);
    const m = velocityByCanonicalId(d);
    expect(m.size).toBe(0);
    expect(velocityByCanonicalId(null).size).toBe(0);
    expect(velocityByCanonicalId({}).size).toBe(0);
    expect(velocityByCanonicalId(doc([])).size).toBe(0);
  });
});
