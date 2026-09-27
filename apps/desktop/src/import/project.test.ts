import { describe, expect, it } from "vitest";
import type { ScoreDocumentPort } from "../score/document";
import type { LoadedAudio } from "./types";
import {
  buildProjectDocument,
  deriveProjectId,
  isSaveableRevision,
  validateProjectDocument,
  writeProjectDocument,
} from "./project";

function fakeDoc(
  overrides: Partial<ScoreDocumentPort> = {},
): ScoreDocumentPort {
  return {
    revisionId: "rev-0123456789abcdef",
    editVersion: 0,
    meta: {
      title: "t",
        composer: null,
        arranger: null,
      tempoBpm: 120,
      meter: "4/4",
      pickupBeats: null,
      keyFifths: 0,
      keyChanges: [],
      tempoChanges: [],
      keyMode: null,
      swingFeel: false,
      omittedIssueCount: 0,
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
    ref: {
      kind: "path",
      path: "C:\\audio\\take.wav",
      name: "take.wav",
      contentHash: "ab".repeat(32),
    },
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
      contentHash: "ab".repeat(32),
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

  it("#360: persists still-deferred omitted issues verbatim", async () => {
    const deferred = [
      {
        id: "ri-000061",
        scoreRevision: "rev-0123456789abcdef",
        canonicalNoteIds: ["sn-000001"],
        reason: "low_model_confidence" as const,
        severity: "warning" as const,
        evidence: {},
        status: "open" as const,
      },
    ];
    const doc = await buildProjectDocument({
      audio: null,
      doc: fakeDoc({ deferredReviewIssues: () => deferred }),
      result: RESULT,
    });
    expect(doc!.omittedReviewIssues).toBe(deferred);
    // A document without the optional port method falls back to the
    // job result's extras (older saves / fixture path).
    const docOld = await buildProjectDocument({
      audio: null,
      doc: fakeDoc(),
      result: { ...RESULT, omittedReviewIssues: deferred },
    });
    expect(docOld!.omittedReviewIssues).toBe(deferred);
  });

  it("#12: persists 区間ラベル as a validator-ignored extra", async () => {
    const labels = [
      { label: "Aメロ", startSec: 0, endSec: 30 },
      { label: "サビ", startSec: 30, endSec: 60 },
    ];
    const doc = await buildProjectDocument({
      audio: null,
      doc: fakeDoc(),
      result: RESULT,
      regionLabels: labels,
    });
    expect(doc!.regionLabels).toEqual(labels);
    // extras はバリデータの対象外 — 検証が落ちないこと。
    expect(validateProjectDocument(doc)).toBeNull();
    // 省略時は空配列。
    const bare = await buildProjectDocument({
      audio: null,
      doc: fakeDoc(),
      result: RESULT,
    });
    expect(bare!.regionLabels).toEqual([]);
  });
});

describe("#222/#243: identity + source hash", () => {
  it("keeps the recorded projectId on re-save", async () => {
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc(),
      result: RESULT,
      projectId: "prj-0123456789abcdef",
    });
    expect(doc!.projectId).toBe("prj-0123456789abcdef");
  });

  it("projectId does not follow scoreRevision", async () => {
    const a = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc({ revisionId: "rev-0123456789abcdef" }),
      result: RESULT,
    });
    const b = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc({ revisionId: "rev-ffffffffffffffff" }),
      result: RESULT,
    });
    // Same source + title → same project identity even after the
    // score revision changed (#222).
    expect(a!.projectId).toBe(b!.projectId);
  });

  it("prefers the canonical sourceAudioHash over the ref hash (#243)", async () => {
    const canonical = { sourceAudioHash: "cd".repeat(32) };
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc({ canonicalDocument: () => canonical }),
      result: RESULT,
    });
    expect(doc!.sourceAudio).toEqual({
      originalPath: "C:\\audio\\take.wav",
      contentHash: "cd".repeat(32),
    });
  });

  it("never writes an empty contentHash", async () => {
    const audio = fakeAudio();
    (audio.ref as { contentHash?: string }).contentHash = undefined;
    const doc = await buildProjectDocument({
      audio,
      doc: fakeDoc(),
      result: RESULT,
    });
    // No verified hash anywhere → the source block is omitted,
    // never written as the schema-invalid empty string (#243).
    expect(doc!.sourceAudio).toBeNull();
  });
});

/* #389: the shell-side validator mirrors HornScribeProject.from_dict
 * — manual save runs it before project_write, autosave before the
 * recovery write. Invalid documents fail closed: nothing touches
 * disk. */
describe("validateProjectDocument", () => {
  async function validProject() {
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc(),
      result: RESULT,
    });
    expect(doc).not.toBeNull();
    return doc!;
  }

  it("accepts the buildProjectDocument output", async () => {
    expect(validateProjectDocument(await validProject())).toBeNull();
  });

  it("rejects missing/wrong schemaVersion", async () => {
    const base = await validProject();
    expect(
      validateProjectDocument({ ...base, schemaVersion: undefined }),
    ).toMatch(/schemaVersion/);
    expect(
      validateProjectDocument({ ...base, schemaVersion: 2 }),
    ).toMatch(/schemaVersion/);
    expect(
      validateProjectDocument({ ...base, schemaVersion: "1" }),
    ).toMatch(/schemaVersion/);
  });

  it("rejects a malformed projectId", async () => {
    const base = await validProject();
    expect(
      validateProjectDocument({ ...base, projectId: "x" }),
    ).toMatch(/projectId/);
    expect(
      validateProjectDocument({ ...base, projectId: 42 }),
    ).toMatch(/projectId/);
  });

  it("rejects a malformed sourceAudio / transcription / score ref", async () => {
    const base = await validProject();
    expect(
      validateProjectDocument({
        ...base,
        sourceAudio: { originalPath: "x" },
      }),
    ).toMatch(/sourceAudio/);
    expect(
      validateProjectDocument({
        ...base,
        transcription: { backend: "b", backendVersion: "v", revision: "tr-bad" },
      }),
    ).toMatch(/transcription/);
    expect(
      validateProjectDocument({
        ...base,
        score: { revision: "not-a-rev" },
      }),
    ).toMatch(/score\.revision/);
  });

  it("rejects malformed userEdits / reviewDecisions ids", async () => {
    const base = await validProject();
    expect(
      validateProjectDocument({
        ...base,
        userEdits: [
          {
            id: "ue-0001",
            scoreRevision: "rev-nope",
            kind: "delete",
            targetNoteIds: [],
          },
        ],
      }),
    ).toMatch(/userEdits/);
    expect(
      validateProjectDocument({
        ...base,
        userEdits: [
          {
            id: "ue-0001",
            scoreRevision: "rev-0123456789abcdef",
            kind: "pitch_change",
            targetNoteIds: ["not-a-note"],
          },
        ],
      }),
    ).toMatch(/userEdits/);
    expect(
      validateProjectDocument({
        ...base,
        reviewDecisions: [
          { issueId: "ri-1", scoreRevision: "bad", status: "fixed" },
        ],
      }),
    ).toMatch(/reviewDecisions/);
  });
});

describe("writeProjectDocument", () => {
  it("validates then writes — the write seam never sees an invalid doc", async () => {
    const doc = await buildProjectDocument({
      audio: fakeAudio(),
      doc: fakeDoc(),
      result: RESULT,
    });
    const writes: [string, string][] = [];
    await writeProjectDocument("C:\\out\\take.hornscribe.json", doc!, (p, c) => {
      writes.push([p, c]);
      return Promise.resolve();
    });
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe("C:\\out\\take.hornscribe.json");
    // Same serializer contract as autosave: plain JSON.stringify.
    expect(JSON.parse(writes[0][1]).schemaVersion).toBe(1);
  });

  it("fails closed — invalid documents throw before any write", async () => {
    const writes: [string, string][] = [];
    await expect(
      writeProjectDocument(
        "C:\\out\\take.hornscribe.json",
        { schemaVersion: 2, projectId: "prj-0123456789abcdef" },
        (p, c) => {
          writes.push([p, c]);
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow(/invalid project document/);
    expect(writes).toEqual([]);
  });
});
