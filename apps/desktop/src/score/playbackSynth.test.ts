/**
 * velocityByCanonicalId (#168): the audition carries the detected
 * dynamics. Velocity lives on the canonical payload's notes, not on the
 * MusicXML ParsedNote view, so the synth reads it from canonical truth.
 */
import { describe, expect, it } from "vitest";
import { velocityByCanonicalId } from "./playbackSynth";
import { bendsByCanonicalId } from "./playbackSynth";

function doc(parts: Record<string, unknown>[]): unknown {
  return { content: { parts } };
}

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
