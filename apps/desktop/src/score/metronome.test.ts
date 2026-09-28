/**
 * #101: メトロノーム — measureLayouts (measure_spans 移植), clickTrack
 * (primary beat グリッド), countInMs/countInPattern (1小節分)。
 */
import { describe, expect, it } from "vitest";
import {
  clickTrack,
  countInMs,
  countInPattern,
  measureLayouts,
} from "./metronome";

const TS44 = { beatsPerMeasure: 4, beatUnit: 4 };
const TS34 = { beatsPerMeasure: 3, beatUnit: 4 };
const TS68 = { beatsPerMeasure: 6, beatUnit: 8 };

function note(startBeat: string, durationBeats: string, id = "sn-1") {
  return { id, startBeat, durationBeats };
}

function rest(startBeat: string, totalBeats: string) {
  return { startBeat, atoms: [{ durationBeats: totalBeats }] };
}

function content(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tempoMap: [{ startBeat: "0/1", bpm: 120 }],
    timeSignature: TS44,
    pickupBeats: "0/1",
    parts: [{ id: "P1", name: "", notes: [note("0/1", "4/1")] }],
    quantizationSettings: {},
    ...overrides,
  };
}

function doc(c: Record<string, unknown>): unknown {
  return { content: c };
}

describe("measureLayouts (#101)", () => {
  it("single meter tiles beats_per_measure measures up to content end", () => {
    // end=8 beats → two 4/4 measures, numbered 1 and 2.
    const spans = measureLayouts(
      doc(content({ parts: [{ id: "P1", notes: [note("0/1", "8/1")] }] })),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        number: 1,
        startBeat: 0,
        endBeat: 4,
        implicit: false,
      }),
      expect.objectContaining({
        number: 2,
        startBeat: 4,
        endBeat: 8,
        implicit: false,
      }),
    ]);
  });

  it("a partial last measure keeps its full measure length", () => {
    // end=5 → measure 2 spans [4,8) even though content stops at 5.
    const spans = measureLayouts(
      doc(content({ parts: [{ id: "P1", notes: [note("0/1", "5/1")] }] })),
    );
    expect(spans).toHaveLength(2);
    expect(spans?.[1].endBeat).toBe(8);
  });

  it("rests extend the content end like notes do", () => {
    const spans = measureLayouts(
      doc(
        content({
          parts: [
            {
              id: "P1",
              notes: [note("0/1", "4/1")],
              rests: [rest("4/1", "4/1"), rest("8/1", "4/1")],
            },
          ],
        }),
      ),
    );
    expect(spans?.map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it("pickupBeats produces the implicit anacrusis measure 0", () => {
    const spans = measureLayouts(
      doc(
        content({
          pickupBeats: "1/1",
          parts: [{ id: "P1", notes: [note("0/1", "5/1")] }],
        }),
      ),
    );
    expect(spans?.[0]).toEqual(
      expect.objectContaining({
        number: 0,
        startBeat: 0,
        endBeat: 1,
        implicit: true,
        cycleOffsetBeats: 3,
      }),
    );
    expect(spans?.[1]).toEqual(
      expect.objectContaining({ number: 1, startBeat: 1, endBeat: 5 }),
    );
  });

  it("a meter change clips the running measure then retiles", () => {
    const spans = measureLayouts(
      doc(
        content({
          meterChanges: [
            {
              startBeat: "0/1",
              timeSignature: TS44,
              measurePhaseBeats: "0/1",
            },
            {
              startBeat: "6/1",
              timeSignature: TS34,
              measurePhaseBeats: "0/1",
            },
          ],
          parts: [{ id: "P1", notes: [note("0/1", "14/1")] }],
        }),
      ),
    );
    // 4/4 segment: [0,4), clipped [4,6). 3/4 segment: [6,9), [9,12), [12,15).
    expect(spans?.map((s) => [s.startBeat, s.endBeat])).toEqual([
      [0, 4],
      [4, 6],
      [6, 9],
      [9, 12],
      [12, 15],
    ]);
    expect(spans?.[2].meterChange).toBe(true);
  });

  it("returns null on a malformed payload", () => {
    expect(measureLayouts(null)).toBeNull();
    expect(measureLayouts({})).toBeNull();
    expect(measureLayouts(doc({}))).toBeNull();
    expect(
      measureLayouts(
        doc(content({ timeSignature: { beatsPerMeasure: 0, beatUnit: 4 } })),
      ),
    ).toBeNull();
  });
});

describe("clickTrack (#101)", () => {
  it("4/4 at 120bpm clicks every quarter with accents on downbeats", () => {
    const clicks = clickTrack(
      doc(content({ parts: [{ id: "P1", notes: [note("0/1", "8/1")] }] })),
    );
    expect(clicks?.map((c) => c.startMs)).toEqual([
      0, 500, 1000, 1500, 2000, 2500, 3000, 3500,
    ]);
    expect(clicks?.map((c) => c.accent)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("6/8 clicks the two dotted-quarter primary beats per measure", () => {
    // 6/8 at dotted-quarter=60: beat_ql=0.5ql, mlen=6 canonical beats,
    // primary = 3 beats = 1000ms.
    const clicks = clickTrack(
      doc(
        content({
          timeSignature: TS68,
          tempoMap: [{ startBeat: "0/1", bpm: 60 }],
          parts: [{ id: "P1", notes: [note("0/1", "6/1")] }],
        }),
      ),
    );
    expect(clicks?.map((c) => c.startMs)).toEqual([0, 1000]);
    expect(clicks?.[0].accent).toBe(true);
  });

  it("the anacrusis measure clicks without an accent; measure 1 accents", () => {
    const clicks = clickTrack(
      doc(
        content({
          pickupBeats: "1/1",
          parts: [{ id: "P1", notes: [note("0/1", "5/1")] }],
        }),
      ),
    );
    // pickup beat at 0ms (no accent), then measure 1 beats 1..4.
    expect(clicks?.map((c) => c.startMs)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(clicks?.map((c) => c.accent)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("clicks follow the tempo map through a mid-piece tempo change", () => {
    const clicks = clickTrack(
      doc(
        content({
          tempoMap: [
            { startBeat: "0/1", bpm: 120 },
            { startBeat: "8/1", bpm: 60 },
          ],
          parts: [{ id: "P1", notes: [note("0/1", "12/1")] }],
        }),
      ),
    );
    expect(clicks?.map((c) => c.startMs)).toEqual([
      0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7000,
    ]);
    expect(clicks?.filter((c) => c.accent).map((c) => c.startMs)).toEqual([
      0, 2000, 4000,
    ]);
  });

  it("returns null without a tempo map", () => {
    expect(clickTrack(doc(content({ tempoMap: [] })))).toBeNull();
    expect(clickTrack(null)).toBeNull();
  });
});

describe("countIn (#101)", () => {
  it("one full measure at the play position's tempo (4/4 @120 = 2000ms)", () => {
    const d = doc(content());
    expect(countInMs(d, 0)).toBe(2000);
    const pattern = countInPattern(d, 0);
    expect(pattern.map((c) => c.offsetMs)).toEqual([0, 500, 1000, 1500]);
    expect(pattern.map((c) => c.accent)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("mid-piece position uses the local tempo (60bpm -> 4000ms)", () => {
    const d = doc(
      content({
        tempoMap: [
          { startBeat: "0/1", bpm: 120 },
          { startBeat: "8/1", bpm: 60 },
        ],
        parts: [{ id: "P1", notes: [note("0/1", "12/1")] }],
      }),
    );
    expect(countInMs(d, 5000)).toBe(4000);
    expect(countInPattern(d, 5000).map((c) => c.offsetMs)).toEqual([
      0, 1000, 2000, 3000,
    ]);
  });

  it("6/8 counts in the two felt beats", () => {
    const d = doc(
      content({
        timeSignature: TS68,
        tempoMap: [{ startBeat: "0/1", bpm: 60 }],
        parts: [{ id: "P1", notes: [note("0/1", "6/1")] }],
      }),
    );
    expect(countInMs(d, 0)).toBe(2000);
    expect(countInPattern(d, 0).map((c) => c.offsetMs)).toEqual([0, 1000]);
  });

  it("returns 0/[] on a malformed payload", () => {
    expect(countInMs(null, 0)).toBe(0);
    expect(countInPattern(null, 0)).toEqual([]);
    expect(countInMs(doc(content({ tempoMap: [] })), 0)).toBe(0);
  });
});
