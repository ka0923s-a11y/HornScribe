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
    expect(
      revA.reviewIssues().find((i) => i.id === "ri-000001")!.status,
    ).toBe("accepted");

    // Re-transcription → new revision id → a NEW document instance.
    const revB = createFixtureScoreDocument({ revisionId: "rev-bbbb" });
    expect(
      revB.reviewIssues().find((i) => i.id === "ri-000001")!.status,
    ).toBe("open");
    const sessionB = new ReviewSession(revB);
    expect(sessionB.canUndo).toBe(false);
    expect(openIssues(sessionB.issues())).toHaveLength(3);
  });
});
