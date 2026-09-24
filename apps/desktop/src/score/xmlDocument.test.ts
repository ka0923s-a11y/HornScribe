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

/* #224: the canonical payload is the single source of truth for engine
 * edits — pending overlay edits materialize into it before score.edit
 * so split/merge/requantize operate on what the user sees. */
const CANONICAL_NOTES = {
  projectId: "prj-test",
  revision: "sr-test",
  title: "t",
  content: {
    tempoMap: [],
    parts: [
      {
        id: "part-1",
        name: "Horn in F",
        notes: [
          {
            id: "sn-000001",
            pitchMidi: 60,
            startBeat: "0/1",
            durationBeats: "1/1",
          },
          {
            id: "sn-000002",
            pitchMidi: 62,
            startBeat: "1/1",
            durationBeats: "1/1",
          },
        ],
      },
    ],
  },
};

const makeDoc = (canonical: unknown = CANONICAL_NOTES) =>
  new XmlScoreDocument({
    concertXml: XML,
    hornXml: XML,
    revisionId: "sr-test",
    issues: [],
    canonicalDocument: canonical,
  });

describe("XmlScoreDocument canonical edit materialization (#224)", () => {
  it("canonicalDocument() bakes pitchDelta + deleted into the payload", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 2,
      deleted: false,
      enharmonic: false,
    });
    doc.setNoteEdit("sn-000002", {
      pitchDelta: 0,
      deleted: true,
      enharmonic: false,
    });
    const out = doc.canonicalDocument() as {
      content: { parts: { notes: Record<string, unknown>[] }[] };
    };
    const notes = out.content.parts[0].notes;
    expect(notes[0].pitchMidi).toBe(62);
    expect(notes[0].deleted).toBeUndefined();
    expect(notes[1].deleted).toBe(true);
    // The stored canonical is untouched (materialize returns a copy).
    const raw = CANONICAL_NOTES.content.parts[0].notes;
    expect(raw[0].pitchMidi).toBe(60);
  });

  it("materializedNoteEdits keeps only enharmonic on surviving notes", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 1,
      deleted: false,
      enharmonic: true,
    });
    doc.setNoteEdit("sn-000002", {
      pitchDelta: 0,
      deleted: true,
      enharmonic: true,
    });
    // sn-000002 becomes canonical-deleted; sn-000003 is new (merge).
    const next = {
      ...CANONICAL_NOTES,
      content: {
        parts: [
          {
            id: "part-1",
            name: "Horn in F",
            notes: [
              {
                id: "sn-000001",
                pitchMidi: 61,
                startBeat: "0/1",
                durationBeats: "1/1",
              },
              {
                id: "sn-000002",
                pitchMidi: 62,
                startBeat: "1/1",
                durationBeats: "1/1",
                deleted: true,
              },
            ],
          },
        ],
      },
    };
    const keep = doc.materializedNoteEdits!(next);
    expect(keep.get("sn-000001")).toEqual({
      pitchDelta: 0,
      deleted: false,
      enharmonic: true,
    });
    // Canonical-deleted note: the whole overlay drops (a rest can't
    // carry spelling edits).
    expect(keep.has("sn-000002")).toBe(false);
  });

  it("undo restores the overlay via the snapshot's noteEdits", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 2,
      deleted: false,
      enharmonic: false,
    });
    const prev = doc.contentSnapshot!();
    expect(prev.noteEdits.get("sn-000001")?.pitchDelta).toBe(2);
    // Engine edit: materialized edits cleared (kept = enharmonic only).
    doc.replaceContent({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-next",
      canonicalDocument: doc.canonicalDocument(),
      noteEdits: doc.materializedNoteEdits!(doc.canonicalDocument()),
    });
    expect(doc.noteEdits().size).toBe(0);
    // Undo restores the snapshot — the overlay returns verbatim.
    doc.replaceContent(prev);
    expect(doc.noteEdits().get("sn-000001")?.pitchDelta).toBe(2);
  });

  it("canonicalNoteDeleted + restore markers survive setNoteEdit", () => {
    const del = {
      ...CANONICAL_NOTES,
      content: {
        parts: [
          {
            id: "part-1",
            name: "Horn in F",
            notes: [
              {
                id: "sn-000001",
                pitchMidi: 60,
                startBeat: "0/1",
                durationBeats: "1/1",
                deleted: true,
              },
            ],
          },
        ],
      },
    };
    const doc = makeDoc(del);
    expect(doc.canonicalNoteDeleted?.("sn-000001")).toBe(true);
    // deleted:true on a canonical-deleted note is neutral — dropped.
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 0,
      deleted: true,
      enharmonic: false,
    });
    expect(doc.noteEdits().size).toBe(0);
    // deleted:false is a RESTORE marker — must be stored.
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 0,
      deleted: false,
      enharmonic: false,
    });
    expect(doc.noteEdits().get("sn-000001")?.deleted).toBe(false);
    // ...and materialization revives the canonical note.
    const out = doc.canonicalDocument() as {
      content: { parts: { notes: Record<string, unknown>[] }[] };
    };
    expect(out.content.parts[0].notes[0].deleted).toBeUndefined();
  });
});
