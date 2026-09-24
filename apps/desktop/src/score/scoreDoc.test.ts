// @vitest-environment jsdom
/**
 * scoreDoc parse tests (UI-030). The parsed model feeds the properties
 * inspector and the accessible score representation.
 */
import { describe, expect, it } from "vitest";
import {
  describeNote,
  noteTypeJa,
  notesByCanonical,
  notesByExportId,
  parseScoreDoc,
  pitchLabel,
} from "./scoreDoc";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="4.0">
  <work><work-title>W</work-title></work>
  <movement-title>Test Piece</movement-title>
  <part-list><score-part id="P1"><part-name>Horn in F</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>-1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="100"/></direction>
      <note id="hs-sn-000001">
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><type>quarter</type>
      </note>
      <note id="hs-sn-000002">
        <pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch>
        <duration>6</duration><type>quarter</type><dot/>
      </note>
      <note id="hs-sn-000003">
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration><type>quarter</type>
        <tie type="start"/><notations><tied type="start"/></notations>
      </note>
      <note id="hs-rest-000001">
        <rest/><duration>6</duration><type>quarter</type><dot/>
      </note>
    </measure>
    <measure number="2">
      <note id="hs-sn-000003-2">
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>16</duration><type>whole</type>
        <tie type="stop"/>
      </note>
    </measure>
  </part>
</score-partwise>`;

describe("parseScoreDoc", () => {
  const doc = parseScoreDoc(XML);

  it("reads title, tempo, meter and key", () => {
    expect(doc.title).toBe("Test Piece");
    expect(doc.tempoBpm).toBe(100);
    expect(doc.meter).toBe("4/4");
    expect(doc.keyFifths).toBe(-1);
    expect(doc.measureCount).toBe(2);
  });

  it("collects key changes with measure numbers (#146)", () => {
    const xml = XML.replace(
      '<measure number="2">',
      '<measure number="2"><attributes><key><fifths>-5</fifths></key></attributes>',
    );
    const doc = parseScoreDoc(xml);
    expect(doc.keyChanges).toEqual([
      { measure: 1, fifths: -1, mode: null },
      { measure: 2, fifths: -5, mode: null },
    ]);
    // Head key stays the first signature.
    expect(doc.keyFifths).toBe(-1);
  });

  it("reads <mode> on the head key and on key changes (#252)", () => {
    const xml = XML.replace(
      "<key><fifths>-1</fifths></key>",
      "<key><fifths>-1</fifths><mode>minor</mode></key>",
    ).replace(
      '<measure number="2">',
      '<measure number="2"><attributes><key><fifths>2</fifths><mode>major</mode></key></attributes>',
    );
    const doc = parseScoreDoc(xml);
    expect(doc.keyMode).toBe("minor");
    expect(doc.keyChanges).toEqual([
      { measure: 1, fifths: -1, mode: "minor" },
      { measure: 2, fifths: 2, mode: "major" },
    ]);
  });

  it("single key yields a one-entry (or empty) change list", () => {
    const doc = parseScoreDoc(XML);
    expect(doc.keyChanges).toEqual([{ measure: 1, fifths: -1, mode: null }]);
  });

  it("parses pitch, type, dots and measure numbers", () => {
    const n1 = doc.notes.find((n) => n.exportId === "hs-sn-000001");
    expect(n1?.step).toBe("C");
    expect(n1?.octave).toBe(4);
    expect(n1?.type).toBe("quarter");
    expect(n1?.dots).toBe(0);
    expect(n1?.measure).toBe(1);
    const n2 = doc.notes.find((n) => n.exportId === "hs-sn-000002");
    expect(n2?.alter).toBe(-1);
    expect(n2?.dots).toBe(1);
  });

  it("marks rests and tie membership", () => {
    const rest = doc.notes.find((n) => n.exportId === "hs-rest-000001");
    expect(rest?.isRest).toBe(true);
    expect(rest?.canonicalId).toBeNull();
    const t1 = doc.notes.find((n) => n.exportId === "hs-sn-000003");
    const t2 = doc.notes.find((n) => n.exportId === "hs-sn-000003-2");
    expect(t1?.tied).toBe(true);
    expect(t2?.tied).toBe(true);
    expect(t2?.measure).toBe(2);
  });

  it("groups tie fragments under one canonical id", () => {
    const map = notesByCanonical(doc);
    expect(map.get("sn-000003")?.map((n) => n.exportId)).toEqual([
      "hs-sn-000003",
      "hs-sn-000003-2",
    ]);
    const byExport = notesByExportId(doc);
    expect(byExport.get("hs-rest-000001")?.isRest).toBe(true);
  });

  it("throws on malformed XML", () => {
    expect(() => parseScoreDoc("<score-partwise><part")).toThrow();
  });
});

describe("labels", () => {
  const doc = parseScoreDoc(XML);
  const n1 = doc.notes.find((n) => n.exportId === "hs-sn-000001")!;
  const n2 = doc.notes.find((n) => n.exportId === "hs-sn-000002")!;
  const rest = doc.notes.find((n) => n.exportId === "hs-rest-000001")!;

  it("formats Japanese pitch labels", () => {
    expect(pitchLabel(n1)).toBe("C4");
    expect(pitchLabel(n2)).toBe("B♭3");
    expect(pitchLabel(rest)).toBe("");
  });

  it("formats Japanese duration labels", () => {
    expect(noteTypeJa(n1)).toBe("四分音符");
    expect(noteTypeJa(n2)).toBe("付点四分音符");
    expect(noteTypeJa(rest)).toBe("付点四分休符");
  });

  it("describes a note for announcements", () => {
    expect(describeNote(n1)).toBe("第1小節 C4 四分音符");
    const t1 = doc.notes.find((n) => n.exportId === "hs-sn-000003")!;
    expect(describeNote(t1)).toContain("・タイ");
  });
});
