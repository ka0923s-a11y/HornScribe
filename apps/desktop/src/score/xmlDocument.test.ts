// @vitest-environment jsdom
/**
 * XmlScoreDocument tempo-map merge (#249): the parsed <sound tempo>
 * marks must each carry the canonical segment's startBeat so the
 * tempo-map editor can edit/remove every row — a mark without a
 * startBeat degrades to display-only by design.
 */
import { describe, expect, it } from "vitest";
import { XmlScoreDocument } from "./xmlDocument";
import type { ScoreReviewIssue } from "./review";

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

// #392: a rhythm edit's engine RPC is async — the user keeps editing
// while it is in flight. rebasedNoteEdits separates the request-time
// overlay (already materialized into the engine input) from the
// in-flight delta (must survive the response), and counts conflicts
// instead of silently dropping edits on merged-away notes.
describe("XmlScoreDocument rebasedNoteEdits (#392)", () => {
  const withNotes = (notes: Record<string, unknown>[]) => ({
    ...CANONICAL_NOTES,
    content: { parts: [{ id: "part-1", name: "Horn", notes }] },
  });
  const note = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    pitchMidi: 60,
    startBeat: "0/1",
    durationBeats: "1/1",
    ...extra,
  });
  const pitch = (d: number) => ({
    pitchDelta: d,
    deleted: false,
    enharmonic: false,
  });

  it("a pitch edit made while the engine edit is in flight survives", () => {
    const doc = makeDoc();
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    // User pitches sn-000001 up while the RPC is in flight.
    doc.setNoteEdit("sn-000001", pitch(1));
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      CANONICAL_NOTES,
      requestOverlay,
    );
    expect(conflicts).toBe(0);
    expect(edits.get("sn-000001")?.pitchDelta).toBe(1);
  });

  it("request-time edits stay materialized — no double-apply", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", pitch(2));
    doc.setNoteEdit("sn-000002", {
      pitchDelta: 0,
      deleted: false,
      enharmonic: true,
    });
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      CANONICAL_NOTES,
      requestOverlay,
    );
    expect(conflicts).toBe(0);
    // Pitch materialized into the engine input — overlay drops it.
    expect(edits.has("sn-000001")).toBe(false);
    // Enharmonic is notation-only — survives as the sole overlay.
    expect(edits.get("sn-000002")?.enharmonic).toBe(true);
  });

  it("an edit cleared in flight stays cleared", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", pitch(2));
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    // The user reverts the pitch while the RPC is in flight — a
    // neutral set removes the overlay entry entirely.
    doc.setNoteEdit("sn-000001", pitch(0));
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      CANONICAL_NOTES,
      requestOverlay,
    );
    expect(conflicts).toBe(0);
    expect(edits.has("sn-000001")).toBe(false);
  });

  it("an edit on a note the engine merged away is a conflict, not a drop", () => {
    const doc = makeDoc();
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    doc.setNoteEdit("sn-000001", pitch(1));
    // The engine result merged sn-000001 into sn-000002 — the id is
    // gone from the new canonical doc.
    const merged = withNotes([note("sn-000002")]);
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      merged,
      requestOverlay,
    );
    expect(conflicts).toBe(1);
    expect(edits.has("sn-000001")).toBe(false);
  });

  it("a delete made in flight survives on a still-live note", () => {
    const doc = makeDoc();
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 0,
      deleted: true,
      enharmonic: false,
    });
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      CANONICAL_NOTES,
      requestOverlay,
    );
    expect(conflicts).toBe(0);
    expect(edits.get("sn-000001")?.deleted).toBe(true);
  });

  it("an engine-deleted note: matching delete is quiet, other intent conflicts", () => {
    const doc = makeDoc();
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    // User pitches sn-000001 up in flight; user deletes sn-000002.
    doc.setNoteEdit("sn-000001", pitch(1));
    doc.setNoteEdit("sn-000002", {
      pitchDelta: 0,
      deleted: true,
      enharmonic: false,
    });
    const engineDeleted = withNotes([
      note("sn-000001", { deleted: true }),
      note("sn-000002", { deleted: true }),
    ]);
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      engineDeleted,
      requestOverlay,
    );
    // sn-000001: pitch on a removed note would resurrect it later.
    expect(conflicts).toBe(1);
    // sn-000002: the delete intent is already canonical — quiet.
    expect(edits.has("sn-000001")).toBe(false);
    expect(edits.has("sn-000002")).toBe(false);
  });

  it("an edit changed in flight rebases the full current intent", () => {
    const doc = makeDoc();
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 0,
      deleted: false,
      enharmonic: true,
    });
    const requestOverlay = doc.contentSnapshot!().noteEdits;
    // The user adds a pitch shift on top during flight — setNoteEdit
    // stores the cumulative intent, enharmonic included.
    doc.setNoteEdit("sn-000001", {
      pitchDelta: 1,
      deleted: false,
      enharmonic: true,
    });
    const { edits, conflicts } = doc.rebasedNoteEdits!(
      CANONICAL_NOTES,
      requestOverlay,
    );
    expect(conflicts).toBe(0);
    expect(edits.get("sn-000001")).toEqual({
      pitchDelta: 1,
      deleted: false,
      enharmonic: true,
    });
  });
});

/* #360: cap-omitted issues ride the result as a deferred pool — the
 * review bar's expand action merges them into the live list, and the
 * pool is revision-bound like the surfaced issue set. */
describe("XmlScoreDocument omitted-issue expansion (#360)", () => {
  const deferred = (n: number, from = 61): ScoreReviewIssue[] =>
    Array.from({ length: n }, (_, i) => ({
      id: "ri-" + String(from + i).padStart(6, "0"),
      scoreRevision: "sr-test",
      canonicalNoteIds: ["sn-000001"],
      reason: "low_model_confidence",
      severity: "warning",
      evidence: {},
      status: "open",
    }));

  it("expand merges deferred issues into the live review list", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
      canonicalDocument: CANONICAL,
      omittedIssues: deferred(10),
    });
    expect(doc.meta.omittedIssueCount).toBe(10);
    expect(doc.reviewIssues()).toHaveLength(0);
    expect(doc.expandOmittedIssues!()).toBe(10);
    expect(doc.reviewIssues()).toHaveLength(10);
    expect(doc.meta.omittedIssueCount).toBe(0);
    expect(doc.deferredReviewIssues!()).toHaveLength(0);
    // Idempotent — a second click adds nothing.
    expect(doc.expandOmittedIssues!()).toBe(0);
  });

  it("deferredReviewIssues overlays recorded decisions for save", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: deferred(2, 1),
      canonicalDocument: CANONICAL,
      omittedIssues: deferred(3),
    });
    doc.recordReviewDecision("ri-000061", "dismissed");
    const saved = doc.deferredReviewIssues!();
    expect(saved.find((i) => i.id === "ri-000061")?.status).toBe(
      "dismissed",
    );
    expect(saved.filter((i) => i.status === "open")).toHaveLength(2);
  });

  it("a revision swap restores each revision's own deferred pool", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
      canonicalDocument: CANONICAL,
      omittedIssues: deferred(10),
    });
    doc.expandOmittedIssues!();
    // An engine edit lands a new revision: the expanded list and the
    // emptied pool both stash under sr-test.
    doc.replaceContent({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-next",
      canonicalDocument: CANONICAL,
    });
    expect(doc.reviewIssues()).toHaveLength(0);
    expect(doc.meta.omittedIssueCount).toBe(0);
    doc.replaceContent({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      canonicalDocument: CANONICAL,
    });
    expect(doc.reviewIssues()).toHaveLength(10);
    expect(doc.deferredReviewIssues!()).toHaveLength(0);
  });

  it("a count-only result keeps its omitted count across a swap", () => {
    const doc = new XmlScoreDocument({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      issues: [],
      canonicalDocument: CANONICAL,
      omittedIssueCount: 7,
    });
    expect(doc.meta.omittedIssueCount).toBe(7);
    doc.replaceContent({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-next",
      canonicalDocument: CANONICAL,
    });
    expect(doc.meta.omittedIssueCount).toBe(0);
    doc.replaceContent({
      concertXml: XML,
      hornXml: XML,
      revisionId: "sr-test",
      canonicalDocument: CANONICAL,
    });
    expect(doc.meta.omittedIssueCount).toBe(7);
  });
});
