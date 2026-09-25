// @vitest-environment node
/** #338: content-identity fingerprint — undoing back to the saved
 *  state compares equal where a monotonic editVersion never could. */
import { describe, expect, it } from "vitest";
import { dirtyFingerprint, dirtySourceIdentity } from "./dirtyFingerprint";
import type { ScoreDocumentPort } from "./document";
import type { LoadedAudio } from "../import/types";

interface DocStub {
  revisionId: string;
  edits: Map<string, { pitchDelta: number; deleted: boolean; enharmonic?: boolean }>;
  issues: { id: string; status: string }[];
  meta: Record<string, unknown>;
}

function doc(stub: DocStub): ScoreDocumentPort {
  return {
    revisionId: stub.revisionId,
    meta: stub.meta,
    noteEdits: () => stub.edits,
    reviewIssues: () => stub.issues,
  } as unknown as ScoreDocumentPort;
}

const META = {
  title: "song",
  composer: null,
  arranger: null,
  tempoBpm: 120,
  meter: "4/4",
  keyFifths: 0,
  keyChanges: [],
  tempoChanges: [],
  keyMode: "major",
  swingFeel: null,
  measureCount: 32,
  noteCount: 128,
  omittedIssueCount: 0,
};

const AUDIO: LoadedAudio = {
  ref: { kind: "path", path: "C:\\audio\\take.wav", name: "take.wav", contentHash: "h1" },
  fileName: "take.wav",
  format: "wav",
  sizeBytes: 1,
  durationSeconds: 60,
  sampleRate: 44_100,
  peaks: [],
  mediaSource: { kind: "blob", blob: new Blob() },
};

function state(over: Partial<DocStub> = {}): DocStub {
  return {
    revisionId: "rev-0123456789abcdef",
    edits: new Map(),
    issues: [],
    meta: META,
    ...over,
  };
}

function fp(stub: DocStub, over: {
  audio?: LoadedAudio | null;
  priorSource?: { originalPath: string; contentHash: string } | null;
  projectId?: string | null;
} = {}): string {
  return dirtyFingerprint({
    doc: doc(stub),
    projectId: over.projectId ?? "prj-1",
    audio: over.audio !== undefined ? over.audio : AUDIO,
    priorSource: over.priorSource ?? null,
  });
}

describe("dirtyFingerprint (#338)", () => {
  it("identical states fingerprint equal — undo back to saved is clean", () => {
    const s = state({
      edits: new Map([["sn-000001", { pitchDelta: 1, deleted: false }]]),
      issues: [{ id: "ri-1", status: "fixed" }],
    });
    expect(fp(s)).toBe(fp(state({
      edits: new Map([["sn-000001", { pitchDelta: 1, deleted: false }]]),
      issues: [{ id: "ri-1", status: "fixed" }],
    })));
    expect(fp(s)).toBe(fp(s));
  });

  it("a remaining note edit reads dirty — pitch, delete and enharmonic facets", () => {
    const clean = state();
    expect(fp(state({
      edits: new Map([["sn-000001", { pitchDelta: 2, deleted: false }]]),
    }))).not.toBe(fp(clean));
    expect(fp(state({
      edits: new Map([["sn-000001", { pitchDelta: 0, deleted: true }]]),
    }))).not.toBe(fp(clean));
    expect(fp(state({
      edits: new Map([["sn-000001", { pitchDelta: 0, deleted: false, enharmonic: true }]]),
    }))).not.toBe(fp(clean));
  });

  it("edit insertion order does not matter — only content", () => {
    const a = state({
      edits: new Map([
        ["sn-000001", { pitchDelta: 1, deleted: false }],
        ["sn-000002", { pitchDelta: 0, deleted: true }],
      ]),
    });
    const b = state({
      edits: new Map([
        ["sn-000002", { pitchDelta: 0, deleted: true }],
        ["sn-000001", { pitchDelta: 1, deleted: false }],
      ]),
    });
    expect(fp(a)).toBe(fp(b));
  });

  it("a review decision alone reads dirty; reverting to open cleans it", () => {
    const open = state({ issues: [{ id: "ri-1", status: "open" }] });
    const fixed = state({ issues: [{ id: "ri-1", status: "fixed" }] });
    expect(fp(fixed)).not.toBe(fp(open));
    // Back-to-open restores the baseline fingerprint.
    expect(fp(state({ issues: [{ id: "ri-1", status: "open" }] }))).toBe(fp(open));
  });

  it("metadata and revision changes read dirty", () => {
    const base = state();
    expect(fp(state({ meta: { ...META, title: "renamed" } }))).not.toBe(fp(base));
    expect(fp(state({ meta: { ...META, tempoBpm: 96 } }))).not.toBe(fp(base));
    expect(fp(state({ revisionId: "rev-fedcba9876543210" }))).not.toBe(fp(base));
  });

  it("a relink to a different source path reads dirty; back to saved path is clean", () => {
    const saved = fp(state(), { priorSource: { originalPath: "C:\\audio\\take.wav", contentHash: "h1" }, audio: null });
    const relinked = fp(state(), {
      audio: { ...AUDIO, ref: { kind: "path", path: "D:\\audio\\take2.wav", name: "take2.wav" } },
      priorSource: { originalPath: "C:\\audio\\take.wav", contentHash: "h1" },
    });
    expect(relinked).not.toBe(saved);
    const back = fp(state(), {
      audio: AUDIO,
      priorSource: { originalPath: "C:\\audio\\take.wav", contentHash: "h1" },
    });
    expect(back).toBe(saved);
  });
});

describe("dirtySourceIdentity", () => {
  it("prefers the loaded ref, falls back to the recorded project source", () => {
    expect(
      dirtySourceIdentity(AUDIO, { originalPath: "x", contentHash: "h" }),
    ).toEqual({ originalPath: "C:\\audio\\take.wav", contentHash: "h1" });
    expect(
      dirtySourceIdentity(null, { originalPath: "x", contentHash: "h" }),
    ).toEqual({ originalPath: "x", contentHash: "h" });
    expect(dirtySourceIdentity(null, null)).toBeNull();
  });
});

