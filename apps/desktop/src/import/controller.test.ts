/**
 * ImportController transition tests (UI-020; the §27 import-side states).
 * Fake ports drive the seams; an event recorder captures screens, states
 * and announcements so the contract is asserted, not the DOM.
 */

import { describe, expect, it } from "vitest";
import {
  ImportController,
  parseProjectFile,
  type ImportEvents,
  type ImportState,
} from "./controller";
import { AudioDecodeError, type DecodedAudio, type ImportPorts } from "./ports";
import type { ScreenState } from "../workspace/screen";
import type {
  AudioFileRef,
  LoadedAudio,
  RecentProjectEntry,
} from "./types";

const DECODED: DecodedAudio = {
  durationSeconds: 12.5,
  sampleRate: 48_000,
  peaks: [0.1, 0.9, 0.3],
};

function projectJson(overrides: Record<string, unknown> = {}): Blob {
  return new Blob([
    JSON.stringify({
      schemaVersion: 1,
      projectId: "proj-1",
      sourceAudio: {
        originalPath: "C:\\audio\\etude.wav",
        contentHash: "hash-etude",
        ...((overrides.sourceAudio as object) ?? {}),
      },
      ...overrides,
    }),
  ]);
}

function makeHarness(portOverrides: Partial<ImportPorts> = {}) {
  const screens: ScreenState[] = [];
  const states: ImportState[] = [];
  const announcements: string[] = [];
  const readyAudios: LoadedAudio[] = [];
  const recents: RecentProjectEntry[][] = [];
  const store = new Map<string, Blob>();

  const events: ImportEvents = {
    onScreenChange: (s) => screens.push(s),
    onState: (s) => states.push(s),
    announce: (m) => announcements.push(m),
    onRecentChange: (e) => recents.push([...e]),
    onAudioReady: (a) => readyAudios.push(a),
  };

  const ports: ImportPorts = {
    pickAudio: async () => null,
    readAudioBytes: async (path) => {
      const b = store.get(path);
      if (!b) throw new Error(`missing file: ${path}`);
      return b;
    },
    readProjectBytes: async (path) => {
      const b = store.get(path);
      if (!b) throw new Error(`missing project: ${path}`);
      return b;
    },
    decodeAudio: async () => DECODED,
    sha256Hex: async (blob) => {
      const text = await blob.text();
      return `hash-${text}`;
    },
    ...portOverrides,
  };

  const storage = new Map<string, string>();
  const controller = new ImportController(ports, events, {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, v),
  });

  return {
    controller,
    ports,
    store,
    screens,
    states,
    announcements,
    readyAudios,
    recents,
  };
}

const fileRef = (name = "take.wav", content = "bytes"): AudioFileRef => ({
  kind: "file",
  file: new File([content], name),
  name,
});

const pathRef = (path: string, name = path.split("\\").pop() ?? path): AudioFileRef => ({
  kind: "path",
  path,
  name,
});

describe("importRefs — EMPTY → OPENING_AUDIO → AUDIO_READY", () => {
  it("loads a supported file and announces it", async () => {
    const h = makeHarness();
    await h.controller.importRefs([fileRef("take.wav")]);

    expect(h.screens).toEqual(["openingAudio", "audioReady"]);
    const audio = h.readyAudios[0];
    expect(audio.fileName).toBe("take.wav");
    expect(audio.format).toBe("wav");
    expect(audio.durationSeconds).toBe(DECODED.durationSeconds);
    expect(audio.mediaSource.kind).toBe("blob");
    expect(h.controller.getState().phase).toBe("ready");
    expect(h.announcements.at(-1)).toContain("take.wav");
  });

  it("picks the first supported file when several are dropped", async () => {
    const h = makeHarness();
    await h.controller.importRefs([
      fileRef("notes.txt"),
      fileRef("real.flac"),
      fileRef("other.wav"),
    ]);
    expect(h.readyAudios[0]?.fileName).toBe("real.flac");
  });

  it("reads bytes through the port for kind:path refs", async () => {
    const h = makeHarness();
    h.store.set("C:\\audio\\take.wav", new Blob(["wav-bytes"]));
    const calls: string[] = [];
    const ports = {
      ...h.ports,
      readAudioBytes: async (p: string) => {
        calls.push(p);
        return h.store.get(p)!;
      },
    };
    const c = new ImportController(ports, {
      onScreenChange: () => {},
      onState: () => {},
      announce: () => {},
      onRecentChange: () => {},
      onAudioReady: (a) => h.readyAudios.push(a),
    });
    await c.importRefs([pathRef("C:\\audio\\take.wav", "take.wav")]);
    expect(calls).toEqual(["C:\\audio\\take.wav"]);
    expect(h.readyAudios[0]?.sizeBytes).toBe("wav-bytes".length);
  });
});

describe("importRefs — AUDIO_ERROR (§20)", () => {
  it("unsupported extension → error card, 閉じる → EMPTY", async () => {
    const h = makeHarness();
    await h.controller.importRefs([fileRef("memo.txt")]);

    expect(h.screens).toEqual(["audioError"]);
    const s = h.controller.getState();
    expect(s.phase).toBe("error");
    expect(s.issue).toEqual({ kind: "unsupported", fileName: "memo.txt" });
    expect(h.readyAudios).toHaveLength(0);

    h.controller.dismiss();
    expect(h.controller.getState().phase).toBe("idle");
    expect(h.screens.at(-1)).toBe("empty");
  });

  it("decode failure → openFailed, file is only read", async () => {
    const h = makeHarness({
      decodeAudio: async () => {
        throw new AudioDecodeError("cannot decode");
      },
    });
    await h.controller.importRefs([fileRef("corrupt.wav")]);
    expect(h.controller.getState().issue).toEqual({
      kind: "openFailed",
      fileName: "corrupt.wav",
    });
    expect(h.screens.at(-1)).toBe("audioError");
  });

  it("a failed re-import keeps the live workspace and raises an issue", async () => {
    const h = makeHarness();
    await h.controller.importRefs([fileRef("good.wav")]);
    await h.controller.importRefs([fileRef("bad.xyz")]);

    const s = h.controller.getState();
    expect(s.phase).toBe("ready");
    expect(s.audio?.fileName).toBe("good.wav");
    expect(s.issue?.kind).toBe("unsupported");
    // The screen stays audioReady — the issue renders as a dialog.
    expect(h.screens.at(-1)).toBe("audioReady");

    h.controller.dismiss();
    expect(h.controller.getState().issue).toBeNull();
    expect(h.controller.getState().audio?.fileName).toBe("good.wav");
  });
});

describe("openProject — source verification (store.py contract)", () => {
  const entry: RecentProjectEntry = {
    name: "etude",
    path: "C:\\p\\etude.hornscribe.json",
    openedAt: 1,
  };

  it("hash match → AUDIO_READY and the project is touched as recent", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"])); // hash-etude

    await h.controller.openProject(entry);

    expect(h.screens).toEqual(["openingAudio", "audioReady"]);
    expect(h.readyAudios[0]?.fileName).toBe("etude.wav");
    expect(h.recents.at(-1)?.[0]?.path).toBe(entry.path);
  });

  it("source file missing → SOURCE_MISSING with relink action", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson());
    // no audio bytes stored → read fails
    await h.controller.openProject(entry);

    expect(h.screens).toEqual(["openingAudio", "sourceMissing"]);
    const s = h.controller.getState();
    expect(s.phase).toBe("sourceMissing");
    expect(s.sourceMissing?.project.sourcePath).toBe("C:\\audio\\etude.wav");
    expect(s.sourceMissing?.mismatch).toBe(false);
  });

  it("hash mismatch at the recorded path → SOURCE_MISSING", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["different"]));
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
  });

  it("corrupt project JSON → projectOpenFailed (not SOURCE_MISSING)", async () => {
    const h = makeHarness();
    h.store.set(entry.path, new Blob(["{corrupt"]));
    await h.controller.openProject(entry);
    const s = h.controller.getState();
    expect(s.phase).toBe("error");
    expect(s.issue).toEqual({
      kind: "projectOpenFailed",
      fileName: "etude",
    });
    expect(h.screens.at(-1)).toBe("audioError");
  });
});

describe("relinkWith — hash-validated relink (store.py relink_source_audio)", () => {
  const entry: RecentProjectEntry = {
    name: "etude",
    path: "C:\\p\\etude.hornscribe.json",
    openedAt: 1,
  };

  async function toSourceMissing(h: ReturnType<typeof makeHarness>) {
    h.store.set(entry.path, projectJson());
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
  }

  it("matching content → AUDIO_READY + sourceRelinked announce", async () => {
    const h = makeHarness();
    await toSourceMissing(h);
    // Fake sha256Hex is `hash-${text}` — content "etude" matches hash-etude.
    await h.controller.relinkWith(fileRef("etude-copy.wav", "etude"));

    const s = h.controller.getState();
    expect(s.phase).toBe("ready");
    expect(s.audio?.mediaSource.kind).toBe("blob");
    expect(h.screens.at(-1)).toBe("audioReady");
    expect(h.announcements.at(-1)).toContain("関連付け直");
    expect(h.recents.at(-1)?.[0]?.path).toBe(entry.path);
  });

  it("different content → SOURCE_MISSING with mismatch=true", async () => {
    const h = makeHarness();
    await toSourceMissing(h);
    await h.controller.relinkWith(fileRef("nope"));

    const s = h.controller.getState();
    expect(s.phase).toBe("sourceMissing");
    expect(s.sourceMissing?.mismatch).toBe(true);
    expect(h.screens.at(-1)).toBe("sourceMissing");
  });

  it("unreadable candidate keeps SOURCE_MISSING (recovery path stays)", async () => {
    const h = makeHarness();
    await toSourceMissing(h);
    await h.controller.relinkWith(pathRef("C:\\gone\\etude.wav"));

    const s = h.controller.getState();
    expect(s.phase).toBe("sourceMissing");
    expect(s.sourceMissing?.mismatch).toBe(false);
  });
});

describe("serialization guard", () => {
  it("a superseded open cannot overwrite the newer one", async () => {
    let resolveFirst!: (v: DecodedAudio) => void;
    const h = makeHarness({
      decodeAudio: (blob) =>
        blob.size === 5
          ? new Promise<DecodedAudio>((r) => (resolveFirst = r))
          : Promise.resolve(DECODED),
    });

    const first = h.controller.importRefs([fileRef("slow.wav", "12345")]);
    const second = h.controller.importRefs([fileRef("fast.mp3", "12")]);
    await second;
    resolveFirst(DECODED);
    await first;

    const s = h.controller.getState();
    expect(s.audio?.fileName).toBe("fast.mp3");
    expect(h.readyAudios.map((a) => a.fileName)).toEqual(["fast.mp3"]);
  });
});

describe("openViaDialog", () => {
  it("cancel is silent — no state change, no announcement", async () => {
    const h = makeHarness();
    await h.controller.openViaDialog();
    expect(h.states).toHaveLength(0);
    expect(h.screens).toHaveLength(0);
    expect(h.announcements).toHaveLength(0);
  });
});

describe("parseProjectFile", () => {
  const enc = new TextEncoder();
  const parse = (v: unknown) =>
    parseProjectFile(enc.encode(JSON.stringify(v)).buffer as ArrayBuffer, "p");

  it("extracts sourcePath/sourceHash from schema v1", () => {
    const p = parse({
      schemaVersion: 1,
      projectId: "x",
      sourceAudio: { originalPath: "/a.wav", contentHash: "h" },
    });
    expect(p).toMatchObject({
      projectId: "x",
      sourcePath: "/a.wav",
      sourceHash: "h",
    });
  });

  it("throws on wrong schemaVersion / missing projectId / non-object", () => {
    expect(() => parse({ schemaVersion: 2, projectId: "x" })).toThrow();
    expect(() => parse({ schemaVersion: 1 })).toThrow();
    expect(() => parse([1, 2])).toThrow();
  });

  it("tolerates a missing sourceAudio (null source fields)", () => {
    const p = parse({ schemaVersion: 1, projectId: "x", sourceAudio: null });
    expect(p.sourcePath).toBeNull();
    expect(p.sourceHash).toBeNull();
  });
});
