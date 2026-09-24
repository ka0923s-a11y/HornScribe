// @vitest-environment jsdom
/**
 * XmlScoreDocument tempo-map merge (#249): the parsed <sound tempo>
 * marks must each carry the canonical segment's startBeat so the
 * tempo-map editor can edit/remove every row — a mark without a
 * startBeat degrades to display-only by design.
 */
import { describe, expect, it } from "vitest";
import { XmlScoreDocument } from "./xmlDocument";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="4.0">
  <movement-title>Tempo Map</movement-title>
  <part-list><score-part id="P1"><part-name>Horn in F</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note id="hs-sn-000001">
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>16</duration><type>whole</type>
      </note>
    </measure>
    <measure number="2">
      <note id="hs-sn-000002">
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>16</duration><type>whole</type>
      </note>
    </measure>
    <measure number="3">
      <direction><sound tempo="96"/></direction>
      <direction><sound tempo="88"/></direction>
      <note id="hs-sn-000003">
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>16</duration><type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

/** Canonical scoreDocument dict shape (domain/score.py to_dict). */
const CANONICAL = {
  projectId: "prj-test",
  revision: "sr-test",
  title: "Tempo Map",
  content: {
    tempoMap: [
      { startBeat: "0/1", bpm: 120 },
      { startBeat: "8/1", bpm: 96 },
      { startBeat: "10/1", bpm: 88 },
    ],
  },
};

describe("XmlScoreDocument tempo-map merge (#249)", () => {
  it("attaches canonical startBeat to every parsed mark", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
      canonicalDocument: CANONICAL,
    });
    expect(doc.meta.tempoChanges).toEqual([
      { measure: 1, bpm: 120, startBeat: "0/1" },
      { measure: 3, bpm: 96, startBeat: "8/1" },
      { measure: 3, bpm: 88, startBeat: "10/1" },
    ]);
    expect(doc.meta.tempoBpm).toBe(120);
  });

  it("refreshes merged starts when content is swapped", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
      canonicalDocument: CANONICAL,
    });
    const next = {
      ...CANONICAL,
      content: {
        tempoMap: [
          { startBeat: "0/1", bpm: 120 },
          { startBeat: "8/1", bpm: 100 },
          { startBeat: "10/1", bpm: 88 },
        ],
      },
    };
    doc.replaceContent({
      concertXml: XML.replace('tempo="96"', 'tempo="100"'),
      hornXml: XML,
      revisionId: "sr-next",
      canonicalDocument: next,
    });
    expect(doc.meta.tempoChanges[1]).toEqual({
      measure: 3,
      bpm: 100,
      startBeat: "8/1",
    });
  });

  it("degrades to display-only marks without a canonical doc", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
    });
    expect(doc.meta.tempoChanges.length).toBe(3);
    expect(
      doc.meta.tempoChanges.every((c) => c.startBeat === undefined),
    ).toBe(true);
  });
});
