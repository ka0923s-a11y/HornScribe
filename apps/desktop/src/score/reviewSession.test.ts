// @vitest-environment jsdom
/**
 * ReviewSession tests (UI-050): decisions, corrections, undo/redo and the
 * revision-bound persistence contract (domain/review.py — decisions live
 * against (issue_id, score_revision) and never carry across revisions).
 */
import { describe, expect, it } from "vitest";
import { createFixtureScoreDocument } from "./fixtureDocument";
import { openIssues } from "./review";
import { ReviewSession } from "./reviewSession";
import { NO_NOTE_EDIT } from "./scoreEdits";
import { XmlScoreDocument } from "./xmlDocument";
import type { ScoreDocumentPort } from "./document";
import concertXml from "./fixtures/score_concert.musicxml?raw";
import hornXml from "./fixtures/score_horn_in_f.musicxml?raw";

describe("ReviewSession decisions", () => {
  it("accept marks the issue resolved and persists on the document", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    const before = doc.reviewIssues().find((i) => i.id === "ri-000001")!;
    expect(before.status).toBe("open");

    const edit = session.decide("ri-000001", "accepted");
    expect(edit).not.toBeNull();
    expect(edit!.prevStatus).toBe("open");
    expect(edit!.nextStatus).toBe("accepted");
    expect(doc.reviewIssues().find((i) => i.id === "ri-000001")!.status).toBe(
      "accepted",
    );
    expect(session.pendingCount()).toBe(2); // 3 fixture issues − 1
    expect(session.canUndo).toBe(true);
  });

  it("deciding an already-resolved issue is a no-op (null)", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.decide("ri-000001", "dismissed");
    expect(session.decide("ri-000001", "dismissed")).toBeNull();
    expect(session.decide("ri-999999", "accepted")).toBeNull();
  });

  it("undo restores the previous status; redo reapplies it", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.decide("ri-000001", "accepted");
    expect(session.undo()).not.toBeNull();
    expect(session.statusOf("ri-000001")).toBe("open");
    expect(session.canRedo).toBe(true);
    expect(session.redo()).not.toBeNull();
    expect(session.statusOf("ri-000001")).toBe("accepted");
    // A new action invalidates the redo tail.
    session.undo();
    session.decide("ri-000001", "dismissed");
    expect(session.canRedo).toBe(false);
    expect(session.statusOf("ri-000001")).toBe("dismissed");
  });

  it("empty stacks report nothing to undo/redo", () => {
    const session = new ReviewSession(createFixtureScoreDocument());
    expect(session.undo()).toBeNull();
    expect(session.redo()).toBeNull();
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
  });
});

describe("ReviewSession corrections", () => {
  it("pitch correction edits the note AND resolves the issue (fixed)", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    const edit = session.adjustPitch("ri-000001", 1)!;
    expect(edit.nextStatus).toBe("fixed");
    expect(edit.noteChanges).toHaveLength(1);
    expect(session.noteEditOf("sn-000012")).toEqual({
      pitchDelta: 1,
      deleted: false,
      enharmonic: false,
    });
    // The document's MusicXML carries the correction (export sees it too).
    const xml = doc.musicXml("concert");
    const note = new DOMParser()
      .parseFromString(xml, "application/xml")
      .querySelector('note[id="hs-sn-000012"]')!;
    expect(note.querySelector("pitch step")!.textContent).toBe("B");
    expect(note.querySelector("pitch alter")).toBeNull(); // B♭→B natural
  });

  it("pitch shifts accumulate and undo replays the exact inverse", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.adjustPitch("ri-000001", 1);
    session.adjustPitch("ri-000001", 1); // re-fixing is allowed: +2 total
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(2);
    session.undo();
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(1);
    session.undo();
    expect(session.noteEditOf("sn-000012")).toEqual(NO_NOTE_EDIT);
    expect(session.statusOf("ri-000001")).toBe("open");
  });

  it("delete marks notes deleted (→ fixed); restore reopens the issue", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.setNoteDeleted("ri-000003", true); // two-note issue
    expect(session.isDeleted("sn-000034")).toBe(true);
    expect(session.isDeleted("sn-000035")).toBe(true);
    expect(session.statusOf("ri-000003")).toBe("fixed");
    // Deleted notes render as rests in the edited document.
    const xml = doc.musicXml("concert");
    const note = new DOMParser()
      .parseFromString(xml, "application/xml")
      .querySelector('note[id="hs-sn-000034"]')!;
    expect(note.querySelector("rest")).not.toBeNull();

    session.setNoteDeleted("ri-000003", false);
    expect(session.isDeleted("sn-000034")).toBe(false);
    expect(session.statusOf("ri-000003")).toBe("open");
  });

  it("delete is a no-op when the notes are already in that state", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.setNoteDeleted("ri-000001", true);
    expect(session.setNoteDeleted("ri-000001", true)).toBeNull();
  });
});

describe("revision binding (domain/review.py contract)", () => {
  it("the session exposes the document revision decisions are keyed to", () => {
    const doc = createFixtureScoreDocument();
    expect(new ReviewSession(doc).scoreRevision).toBe(doc.revisionId);
  });

  it("a new score revision builds a fresh document — old decisions do not carry", () => {
    const revA = createFixtureScoreDocument({ revisionId: "rev-aaaa" });
    const sessionA = new ReviewSession(revA);
    sessionA.decide("ri-000001", "accepted");
    expect(revA.reviewIssues().find((i) => i.id === "ri-000001")!.status).toBe(
      "accepted",
    );

    // Re-transcription → new revision id → a NEW document instance.
    const revB = createFixtureScoreDocument({ revisionId: "rev-bbbb" });
    expect(revB.reviewIssues().find((i) => i.id === "ri-000001")!.status).toBe(
      "open",
    );
    const sessionB = new ReviewSession(revB);
    expect(sessionB.canUndo).toBe(false);
    expect(openIssues(sessionB.issues())).toHaveLength(3);
  });
});

describe("editNote (#114 - direct edits outside review)", () => {
  it("patches a canonical note and lands on the shared undo stack", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    const edit = session.editNote("sn-000012", { pitchDelta: 1 });
    expect(edit).not.toBeNull();
    expect(edit!.issueId).toBeNull();
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(1);
    // Undo restores the previous edit without touching issue status.
    expect(session.undo()).not.toBeNull();
    expect(session.noteEditOf("sn-000012")).toEqual(NO_NOTE_EDIT);
    expect(session.statusOf("ri-000001")).toBe("open");
    expect(session.redo()).not.toBeNull();
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(1);
  });

  it("toggles delete and enharmonic flags", () => {
    const doc = createFixtureScoreDocument();
    const session = new ReviewSession(doc);
    session.editNote("sn-000012", { enharmonic: true });
    expect(session.noteEditOf("sn-000012").enharmonic).toBe(true);
    // The respell reaches the emitted MusicXML (Bb3 -> A#3).
    const note = new DOMParser()
      .parseFromString(doc.musicXml("concert"), "application/xml")
      .querySelector('note[id="hs-sn-000012"]')!;
    expect(note.querySelector("pitch step")!.textContent).toBe("A");
    expect(note.querySelector("pitch alter")!.textContent).toBe("1");
    session.editNote("sn-000012", { deleted: true });
    expect(session.isDeleted("sn-000012")).toBe(true);
  });

  it("returns null on a no-op patch", () => {
    const session = new ReviewSession(createFixtureScoreDocument());
    expect(session.editNote("sn-000012", { pitchDelta: 0 })).toBeNull();
    expect(session.editNote("sn-000012", { deleted: false })).toBeNull();
  });
});

describe("ReviewSession docSwap (#115 rhythm edits)", () => {
  const CANONICAL = {
    projectId: "pj-test",
    revision: "rev-base",
    content: { parts: [] },
  };

  function engineDoc(): XmlScoreDocument {
    return new XmlScoreDocument({
      concertXml,
      hornXml,
      revisionId: "rev-base",
      issues: [],
      canonicalDocument: CANONICAL,
    });
  }

  it("undo/redo swap the document content back and forth", () => {
    const doc = engineDoc();
    const session = new ReviewSession(doc);
    const prev = doc.contentSnapshot!();
    const next = {
      concertXml: hornXml, // swap bodies so the change is observable
      hornXml: concertXml,
      revisionId: "rev-edited",
      canonicalDocument: { ...CANONICAL, revision: "rev-edited" },
    };
    doc.replaceContent!(next);
    expect(doc.revisionId).toBe("rev-edited");

    const edit = session.commitDocSwap(prev, next);
    expect(edit).not.toBeNull();
    expect(session.canUndo).toBe(true);

    session.undo();
    expect(doc.revisionId).toBe("rev-base");
    expect(doc.musicXml("concert")).toContain("<note");
    expect(doc.contentSnapshot!().concertXml).toBe(concertXml);
    expect(doc.canonicalDocument!()).toBe(CANONICAL);

    session.redo();
    expect(doc.revisionId).toBe("rev-edited");
    expect(doc.contentSnapshot!().concertXml).toBe(hornXml);
    expect((doc.canonicalDocument!() as { revision: string }).revision).toBe(
      "rev-edited",
    );
  });

  it("note edits and decisions survive a content swap (stable ids)", () => {
    const doc = engineDoc();
    const session = new ReviewSession(doc);
    session.editNote("sn-000012", { pitchDelta: 2 });
    const prev = doc.contentSnapshot!();
    const next = { ...prev, revisionId: "rev-edited" };
    doc.replaceContent!(next);
    session.commitDocSwap(prev, next);
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(2);
    session.undo();
    expect(doc.revisionId).toBe("rev-base");
    expect(session.noteEditOf("sn-000012").pitchDelta).toBe(2);
  });

  it("#225: a new revision drops stale issues; undo restores them", () => {
    const ISSUE = {
      id: "ri-000001",
      scoreRevision: "rev-base",
      canonicalNoteIds: ["sn-000012"],
      timeRange: { startSec: 0, endSec: 0.5 },
      reason: "low_model_confidence" as const,
      severity: "caution" as const,
      evidence: {},
      status: "open" as const,
    };
    const doc = new XmlScoreDocument({
      concertXml,
      hornXml,
      revisionId: "rev-base",
      issues: [ISSUE],
      canonicalDocument: CANONICAL,
    });
    doc.recordReviewDecision("ri-000001", "accepted");
    expect(doc.reviewIssues()[0].status).toBe("accepted");

    const prev = doc.contentSnapshot!();
    const next = { ...prev, revisionId: "rev-edited" };
    doc.replaceContent!(next);
    // The old revision's issue must not bleed onto the new revision.
    expect(doc.reviewIssues()).toHaveLength(0);

    // Undo swaps back to rev-base — its issue set and decision return.
    doc.replaceContent!(prev);
    expect(doc.reviewIssues()).toHaveLength(1);
    expect(doc.reviewIssues()[0].status).toBe("accepted");
  });

  it("returns null when the document cannot swap content", () => {
    // A minimal port without the optional #115 methods — e.g. a future
    // non-engine adapter. Rhythm edits stay honestly unavailable there.
    const bare: ScoreDocumentPort = {
      revisionId: "rev-bare",
      editVersion: 0,
      meta: {
        title: "",
        composer: null,
        arranger: null,
        tempoBpm: null,
        meter: null,
        keyFifths: null,
        keyChanges: [],
        keyMode: null,
        swingFeel: false,
        omittedIssueCount: 0,
        measureCount: 0,
        noteCount: 0,
      },
      musicXml: () => "",
      reviewIssues: () => [],
      recordReviewDecision: () => undefined,
      noteEdits: () => new Map(),
      setNoteEdit: () => undefined,
    };
    const session = new ReviewSession(bare);
    const snap = {
      concertXml: "",
      hornXml: "",
      revisionId: "rev-x",
      canonicalDocument: null,
    };
    expect(session.commitDocSwap(snap, snap)).toBeNull();
    expect(session.canUndo).toBe(false);
  });

  it("fixture documents have no canonical payload — rhythm edits gate out", () => {
    const doc = createFixtureScoreDocument();
    expect(doc.canonicalDocument?.() ?? null).toBeNull();
  });
});
