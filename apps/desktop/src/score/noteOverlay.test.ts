/**
 * #402: waveform note-overlay mapping — canonical beats must land on
 * sounding seconds exactly like the audition does (tempo map + swing
 * warp), or the bars would drift off the audio they describe.
 */
import { describe, expect, it } from "vitest";
import { waveformF0Contours, waveformNoteOverlay } from "./noteOverlay";

function note(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "sn-000001",
    pitchMidi: 65,
    startBeat: "0/1",
    durationBeats: "1/1",
    ...overrides,
  };
}

function doc(overrides: Record<string, unknown> = {}): unknown {
  return {
    content: {
      tempoMap: [{ startBeat: "0/1", bpm: 120 }],
      timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
      parts: [{ id: "P1", name: "Horn in F", notes: [note()] }],
      ...overrides,
    },
  };
}

describe("waveformNoteOverlay", () => {
  it("returns [] when the document carries no usable tempo map", () => {
    expect(waveformNoteOverlay(null)).toEqual([]);
    expect(waveformNoteOverlay({})).toEqual([]);
    expect(waveformNoteOverlay(doc({ tempoMap: [] }))).toEqual([]);
    expect(waveformNoteOverlay(doc({ parts: undefined }))).toEqual([]);
  });

  it("maps a straight 120bpm 4/4 note to 500ms beats", () => {
    const out = waveformNoteOverlay(doc());
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBe(0);
    expect(out[0].endSec).toBe(0.5);
    expect(out[0].midi).toBe(65);
    expect(out[0].partIndex).toBe(0);
  });

  it("offsets and scales through mid-piece tempo changes", () => {
    const out = waveformNoteOverlay(
      doc({
        tempoMap: [
          { startBeat: "0/1", bpm: 120 },
          { startBeat: "4/1", bpm: 60 },
        ],
        parts: [
          {
            id: "P1",
            name: "Horn in F",
            notes: [note({ startBeat: "5/1", durationBeats: "2/1" })],
          },
        ],
      }),
    );
    // beats 0..4 @500ms, beat 5 -> 2000+1000 = 3000ms, +2 beats -> 5000ms
    expect(out[0].startSec).toBe(3);
    expect(out[0].endSec).toBe(5);
  });

  it("warps offbeats to the swing phase so bars sit on the audio", () => {
    const out = waveformNoteOverlay(
      doc({
        swingFeel: "2/3",
        parts: [
          {
            id: "P1",
            name: "Horn in F",
            notes: [note({ startBeat: "1/2", durationBeats: "1/2" })],
          },
        ],
      }),
    );
    // written beat 1/2 (250ms written) sounds at phase 2/3 -> ~333ms.
    expect(out[0].startSec).toBeCloseTo((2 / 3) * 0.5, 5);
  });

  it("skips deleted notes and keeps the part index", () => {
    const out = waveformNoteOverlay(
      doc({
        parts: [
          {
            id: "P1",
            name: "Horn in F",
            notes: [note(), note({ id: "sn-2", deleted: true, startBeat: "1/1" })],
          },
          {
            id: "P2",
            name: "Horn in F (2nd voice)",
            notes: [note({ id: "sn-3", pitchMidi: 55, startBeat: "2/1" })],
          },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe("sn-3");
    expect(out[1].partIndex).toBe(1);
    expect(out[1].startSec).toBe(1);
  });

  it("carries canonical pitchBends onto the overlay note (#427)", () => {
    const out = waveformNoteOverlay(
      doc({
        parts: [
          {
            id: "P1",
            name: "Horn in F",
            notes: [
              note({
                pitchBends: [
                  { timeSec: 0, bendSemitones: 0 },
                  { timeSec: 0.5, bendSemitones: 0.5 },
                  { timeSec: 1, bendSemitones: 0 },
                ],
              }),
            ],
          },
        ],
      }),
    );
    expect(out[0].bends).toEqual([
      { pos: 0, semis: 0 },
      { pos: 0.5, semis: 0.5 },
      { pos: 1, semis: 0 },
    ]);
  });

  it("leaves bends undefined for missing or malformed bend lists", () => {
    const out = waveformNoteOverlay(
      doc({
        parts: [
          {
            id: "P1",
            name: "Horn in F",
            notes: [
              note({ id: "sn-a", pitchBends: "oops" }),
              note({
                id: "sn-b",
                startBeat: "1/1",
                pitchBends: [{ timeSec: "x" }],
              }),
            ],
          },
        ],
      }),
    );
    expect(out[0].bends).toBeUndefined();
    expect(out[1].bends).toBeUndefined();
  });
});

describe("waveformF0Contours (#427)", () => {
  it("maps bend fractions to absolute seconds and sounding midi", () => {
    const [c] = waveformF0Contours([
      {
        id: "n1",
        startSec: 2,
        endSec: 4,
        midi: 65,
        partIndex: 0,
        bends: [
          { pos: 0, semis: 0 },
          { pos: 0.25, semis: 0.5 },
          { pos: 1, semis: 0 },
        ],
      },
    ]);
    expect(c.points).toEqual([
      { sec: 2, midi: 65 },
      { sec: 2.5, midi: 65.5 },
      { sec: 4, midi: 65 },
    ]);
  });

  it("clamps out-of-range bend positions into the note span", () => {
    const [c] = waveformF0Contours([
      {
        id: "n1",
        startSec: 0,
        endSec: 1,
        midi: 60,
        partIndex: 0,
        bends: [
          { pos: -0.5, semis: 1 },
          { pos: 2, semis: -1 },
        ],
      },
    ]);
    expect(c.points[0]).toEqual({ sec: 0, midi: 61 });
    expect(c.points[1]).toEqual({ sec: 1, midi: 59 });
  });

  it("draws a flat two-point line when a note has no tracked bends", () => {
    const [c] = waveformF0Contours([
      { id: "n1", startSec: 1, endSec: 2, midi: 72, partIndex: 1 },
    ]);
    expect(c.id).toBe("n1");
    expect(c.partIndex).toBe(1);
    expect(c.points).toEqual([
      { sec: 1, midi: 72 },
      { sec: 2, midi: 72 },
    ]);
  });
});
