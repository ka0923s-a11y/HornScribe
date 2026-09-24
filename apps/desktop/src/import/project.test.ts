import { describe, expect, it } from "vitest";
import type { ScoreDocumentPort } from "../score/document";
import type { LoadedAudio } from "./types";
import {
  buildProjectDocument,
  deriveProjectId,
  isSaveableRevision,
} from "./project";

function fakeDoc(overrides: Partial<ScoreDocumentPort> = {}): ScoreDocumentPort {
  return {
    revisionId: "rev-0123456789abcdef",
    editVersion: 0,
    meta: {
      title: "t",
      tempoBpm: 120,
      meter: "4/4",
      keyFifths: 0,
      keyChanges: [],
      measureCount: 1,
      noteCount: 1,
    },
    musicXml: () => "<xml/>",
    reviewIssues: () => [],
    recordReviewDecision: () => undefined,
    noteEdits: () => new Map(),
    setNoteEdit: () => undefined,
    ...overrides,
  };
}

function fakeAudio(): LoadedAudio {
  return {
    ref: { kind: "path", path: "C:\\audio\\take.wav", name: "take.wav" },
    fileName: "take.wav",
    format: "wav",
    sizeBytes: 100,
    durationSeconds: 5,
    sampleRate: 44100,
    peaks: [0.5],
    mediaSource: { kind: "blob", blob: new Blob() },
  };
}

const RESULT = {
  scoreRevision: "rev-0123456789abcdef",
  scoreDocument: { notes: [] },
  reviewIssues: [],
  meta: {
    backend: "basic_pitch",
    backendVersion: "0.4.0",
    transcriptionRevision: "tr-0123456789abcdef",
    settings: { tempoBpm: 120 },
  },
};

describe("deriveProjectId", () => {
  it("produces a stable prj- id", async () => {
    const a = await deriveProjectId({ x: 1, y: "z" });
    const b = await deriveProjectId({ x: 1, y: "z" });
    expect(a).toBe(b);
    expect(a).toMatch(/^prj-[0-9a-f]{16}$/);
  });
});

describe("isSaveableRevision", () => {
  it("accepts engine revisions, rejects fixture ids", () => {
    expect(isSaveableRevision("rev-0123456789abcdef")).toBe(true);
    expect(isSaveableRevision("rev-fixture0000001")).toBe(false);
    expect(isSaveableRevision("sr-0001")).toBe(false);
  });
});

describe("buildProjectDocument", () => {
  it("assembles a schema-v1 document", async () => {
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc(),
      result: RESULT,
    });
    expect(doc).not.toBeNull();
    expect(doc!.schemaVersion).toBe(1);
    expect(doc!.projectId).toMatch(/^prj-/);
    expect(doc!.sourceAudio).toEqual({
      originalPath: "C:\\audio\\take.wav",
      contentHash: "",
    });
    expect(doc!.transcription).toMatchObject({
      backend: "basic_pitch",
      revision: "tr-0123456789abcdef",
    });
    expect(doc!.score).toMatchObject({ revision: "rev-0123456789abcdef" });
    expect(doc!.musicXmlConcert).toBe("<xml/>");
  });

  it("returns null for a non-schema (fixture) revision", async () => {
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc({ revisionId: "rev-fixture0000001" }),
      result: RESULT,
    });
    expect(doc).toBeNull();
  });

  it("maps note edits and review decisions", async () => {
    const doc = await buildProjectDocument({
      audio: null,
      doc: fakeDoc({
        noteEdits: () =>
          new Map([["sn-000003", { pitchDelta: 1, deleted: true }]]),
        reviewIssues: () => [
          {
            id: "ri-1",
            scoreRevision: "rev-0123456789abcdef",
            canonicalNoteIds: ["sn-000003"],
            reason: "other",
            severity: "info",
            evidence: {},
            status: "accepted",
          },
        ],
      }),
      result: RESULT,
    });
    const edits = doc!.userEdits as { kind: string }[];
    expect(edits.map((e) => e.kind)).toEqual(["pitch_change", "delete"]);
    const decisions = doc!.reviewDecisions as { status: string }[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("accepted");
    expect(doc!.sourceAudio).toBeNull();
  });

  it("#115: saves the live canonical payload, not the stale job result", async () => {
    // After an engine rhythm edit the document's scoreDocument is newer
    // than the completed job's — the project must carry the live one or
    // the edit is lost on reopen.
    const live = { content: { parts: [{ notes: [{ id: "sn-000001" }] }] } };
    const doc = await buildProjectDocument({
      audio: null,
      doc: fakeDoc({ canonicalDocument: () => live }),
      result: RESULT,
    });
    expect(doc!.scoreDocument).toBe(live);
    // A document without the canonical payload falls back to the result's.
    const docNoCanon = await buildProjectDocument({
      audio: null,
      doc: fakeDoc(),
      result: RESULT,
    });
    expect(docNoCanon!.scoreDocument).toEqual({ notes: [] });
  });
});
