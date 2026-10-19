/**
 * #389: region labels -> rehearsal marks.
 */
import { describe, expect, it } from "vitest";
import {
  rehearsalMarksFor,
  withRehearsalMarks,
} from "./rehearsalMarks";
import type { RegionLabel } from "../workspace/regionLabels";

/** Minimal canonical payload: 4/4 @120bpm, 4 measures, no pickup.
 *  One canonical beat = 500 ms; one measure = 2 s. */
const DOC = {
  content: {
    tempoMap: [{ startBeat: "0/1", bpm: 120 }],
    timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
    pickupBeats: "0/1",
    meterChanges: [],
    parts: [
      {
        notes: [
          { id: "sn-1", pitchMidi: 64, startBeat: "0/1", durationBeats: "1/1" },
          { id: "sn-2", pitchMidi: 64, startBeat: "15/1", durationBeats: "1/1" },
        ],
        rests: [],
      },
    ],
  },
};

const XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<score-partwise>",
  "  <part-list><score-part id=\"P1\"><part-name>Lead</part-name></score-part></part-list>",
  '  <part id="P1">',
  '    <measure implicit="no" number="1">',
  "      <attributes>",
  "        <divisions>480</divisions>",
  "      </attributes>",
  '      <note><pitch/><duration>1920</duration></note>',
  "    </measure>",
  '    <measure implicit="no" number="2">',
  '      <note><pitch/><duration>1920</duration></note>',
  "    </measure>",
  '    <measure implicit="no" number="3">',
  '      <note><pitch/><duration>1920</duration></note>',
  "    </measure>",
  "  </part>",
  "</score-partwise>",
].join("\n");

function label(label: string, startSec: number, endSec = startSec + 1): RegionLabel {
  return { id: "rl-" + label, label, startSec, endSec };
}

describe("rehearsalMarksFor", () => {
  it("maps a label's start second to its containing measure", () => {
    // 4.0s -> beat 8 -> measure 3 (m1: 0-4, m2: 4-8, m3: 8-12 beats)
    const marks = rehearsalMarksFor([label("サビ", 4.0)], DOC);
    expect(marks).toEqual([{ measure: 3, offsetBeats: 0, text: "サビ" }]);
  });

  it("keeps a mid-measure label's beat offset", () => {
    // 5.0s -> beat 10 -> measure 3, offset 2 beats in
    const marks = rehearsalMarksFor([label("Aメロ", 5.0)], DOC);
    expect(marks).toEqual([{ measure: 3, offsetBeats: 2, text: "Aメロ" }]);
  });

  it("merges same-measure labels into one mark", () => {
    const marks = rehearsalMarksFor(
      [label("サビ", 4.0), label("後半", 5.0)],
      DOC,
    );
    expect(marks).toHaveLength(1);
    expect(marks![0].text).toBe("サビ / 後半");
  });

  it("drops labels past content end and before beat 0", () => {
    const marks = rehearsalMarksFor([label("末尾", 60.0)], DOC);
    expect(marks).toEqual([]);
  });

  it("returns [] for no labels, null for an unmappable document", () => {
    expect(rehearsalMarksFor([], DOC)).toEqual([]);
    expect(rehearsalMarksFor([label("x", 1.0)], null)).toBeNull();
    expect(
      rehearsalMarksFor([label("x", 1.0)], { content: {} }),
    ).toBeNull();
  });
});

describe("withRehearsalMarks", () => {
  it("injects a boxed rehearsal direction after the measure attributes", () => {
    const out = withRehearsalMarks(
      XML,
      [{ measure: 2, offsetBeats: 0, text: "サビ" }],
      DOC,
    );
    expect(out).toContain('<rehearsal enclosure="box">サビ</rehearsal>');
    const m2 = out.indexOf('number="2"');
    const dir = out.indexOf("<direction");
    const note = out.indexOf("<note>", m2);
    expect(dir).toBeGreaterThan(m2);
    expect(dir).toBeLessThan(note);
    expect(out).not.toContain("<offset>");
    expect(out).toContain("<staff>1</staff>");
  });

  it("emits an offset in divisions for mid-measure marks", () => {
    const out = withRehearsalMarks(
      XML,
      [{ measure: 2, offsetBeats: 2, text: "後半" }],
      DOC,
    );
    // beatQl=1 (4/4) × divisions 480 × 2 beats
    expect(out).toContain("<offset>960</offset>");
  });

  it("XML-escapes label text", () => {
    const out = withRehearsalMarks(
      XML,
      [{ measure: 2, offsetBeats: 0, text: 'A<B & "C"' }],
      DOC,
    );
    expect(out).toContain("A&lt;B &amp; &quot;C&quot;");
  });

  it("returns the input untouched when there is nothing to inject", () => {
    expect(withRehearsalMarks(XML, [], DOC)).toBe(XML);
    expect(
      withRehearsalMarks(XML, [{ measure: 99, offsetBeats: 0, text: "x" }], DOC),
    ).toBe(XML);
  });

  it("injects only into the first part", () => {
    const two = XML.replace(
      "</score-partwise>",
      '  <part id="P2"><measure number="2"><note/></measure></part></score-partwise>',
    );
    const out = withRehearsalMarks(
      two,
      [{ measure: 2, offsetBeats: 0, text: "サビ" }],
      DOC,
    );
    expect(out.match(/<rehearsal/g)).toHaveLength(1);
    const p2 = out.indexOf('id="P2"');
    expect(out.indexOf("<rehearsal", 0)).toBeLessThan(p2);
  });
});
