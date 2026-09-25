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
import { ja } from "../strings/ja";
import type { ScreenState } from "../workspace/screen";
import type {
  AudioFileRef,
  LoadedAudio,
  ProjectSummary,
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

/** Same chunked UTF-8→base64 as production `blobToBase64` — lets the
 *  byte-open test assert the exact `documentBase64` payload. */
async function blobToBase64ForTest(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function makeHarness(portOverrides: Partial<ImportPorts> = {}) {
  const screens: ScreenState[] = [];
  const states: ImportState[] = [];
  const announcements: string[] = [];
  const readyAudios: LoadedAudio[] = [];
  const recents: RecentProjectEntry[][] = [];
  const scoreResults: unknown[] = [];
  const scoreProjectPaths: (string | undefined)[] = [];
  const scoreProjects: { path: string; recovered?: boolean }[] = [];
  const openedProjects: ProjectSummary[] = [];
  const relinkedProjects: ProjectSummary[] = [];
  const sourceRefUpdates: [string, string | null][] = [];
  const eventOrder: string[] = [];
  const store = new Map<string, Blob>();

  const events: ImportEvents = {
    onScreenChange: (s) => screens.push(s),
    onState: (s) => states.push(s),
    announce: (m) => announcements.push(m),
    onRecentChange: (e) => recents.push([...e]),
    onAudioReady: (a) => {
      eventOrder.push("audioReady");
      readyAudios.push(a);
    },
    onProjectScoreReady: (r, project) => {
      scoreResults.push(r);
      scoreProjectPaths.push(project.path);
      scoreProjects.push(project);
    },
    onProjectOpened: (p) => {
      eventOrder.push("projectOpened");
      openedProjects.push(p);
    },
    onProjectRelinked: (p) => relinkedProjects.push(p),
  };

  const ports: ImportPorts = {
    pickAudio: async () => null,
    pickProject: async () => null,
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
    updateSourceRef: (projectPath, sourcePath) => {
      sourceRefUpdates.push([projectPath, sourcePath]);
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
    scoreResults,
    scoreProjectPaths,
    scoreProjects,
    openedProjects,
    relinkedProjects,
    sourceRefUpdates,
    eventOrder,
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

  it("hashes the picked bytes once at import (#243)", async () => {
    const h = makeHarness();
    await h.controller.importRefs([fileRef("take.wav", "bytes")]);
    const ref = h.readyAudios[0]?.ref;
    // Fake sha256Hex is hash-<text> — the ref now carries the
    // content identity project save needs.
    expect(ref && "contentHash" in ref ? ref.contentHash : null)
      .toBe("hash-bytes");
  });

  it("picks the first supported file when several are dropped", async () => {
    const h = makeHarness();
    await h.controller.importRefs([
      fileRef("notes.txt"),
      fileRef("real.flac"),
      fileRef("other.wav"),
    ]);
    expect(h.readyAudios[0]?.fileName).toBe("real.flac");
    // #348: the single-file constraint is announced, not silent.
    expect(h.announcements).toContain(
      ja.import.feedback.multiFileNotice,
    );
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

  /* #230: a native probe means path-backed sources never copy bytes
   * into the webview — hash/metadata/peaks come from Rust and playback
   * streams via media://. */
  it("native probe: no byte read, mediaSource is the media:// URL (#230)", async () => {
    const probe = {
      durationSeconds: 12.5,
      sampleRate: 48_000,
      channels: 2,
      sizeBytes: 1_234,
      contentHash: "hash-probed",
      peaks: [0.2, 0.8],
      playbackUrl: "http://media.localhost/tok",
    };
    let byteReads = 0;
    let decodes = 0;
    const h = makeHarness({
      probeAudio: async () => probe,
      readAudioBytes: async () => {
        byteReads += 1;
        throw new Error("must not read bytes");
      },
      decodeAudio: async () => {
        decodes += 1;
        return DECODED;
      },
    });
    await h.controller.importRefs([pathRef("C:\\audio\\take.wav", "take.wav")]);
    expect(byteReads).toBe(0);
    expect(decodes).toBe(0);
    const audio = h.readyAudios[0];
    expect(audio?.mediaSource).toEqual({ kind: "url", url: probe.playbackUrl });
    expect(audio?.ref).toMatchObject({ contentHash: "hash-probed" });
    expect(audio?.durationSeconds).toBe(12.5);
    expect(h.screens).toEqual(["openingAudio", "audioReady"]);
  });

  it("probe returning null falls back to the byte path (#230)", async () => {
    const h = makeHarness({ probeAudio: async () => null });
    h.store.set("C:\\audio\\take.wav", new Blob(["wav-bytes"]));
    await h.controller.importRefs([pathRef("C:\\audio\\take.wav", "take.wav")]);
    const audio = h.readyAudios[0];
    expect(audio?.mediaSource.kind).toBe("blob");
    expect(audio?.sizeBytes).toBe("wav-bytes".length);
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

  it("records the source ref into the persistent index port (#147)", async () => {
    const calls: { projectPath: string; sourcePath: string | null }[] = [];
    const h = makeHarness({
      updateSourceRef: (projectPath, sourcePath) => {
        calls.push({ projectPath, sourcePath });
      },
    });
    h.store.set(entry.path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));

    await h.controller.openProject(entry);

    expect(calls).toEqual([
      { projectPath: entry.path, sourcePath: "C:\\audio\\etude.wav" },
    ]);
  });

  it("records the ref even when the open lands on SOURCE_MISSING (#147)", async () => {
    const calls: { projectPath: string; sourcePath: string | null }[] = [];
    const h = makeHarness({
      updateSourceRef: (projectPath, sourcePath) => {
        calls.push({ projectPath, sourcePath });
      },
    });
    h.store.set(entry.path, projectJson());
    // no audio bytes → SOURCE_MISSING, but the project file still
    // references the source until it is re-saved.
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
    expect(calls).toEqual([
      { projectPath: entry.path, sourcePath: "C:\\audio\\etude.wav" },
    ]);
  });

  it("native probe verifies the hash and streams playback (#230)", async () => {
    const probe = {
      durationSeconds: 12.5,
      sampleRate: 48_000,
      channels: 2,
      sizeBytes: 999,
      contentHash: "hash-etude",
      peaks: [0.5],
      playbackUrl: "http://media.localhost/tok",
    };
    let byteReads = 0;
    const h = makeHarness({
      probeAudio: async () => probe,
      readAudioBytes: async () => {
        byteReads += 1;
        throw new Error("must not read bytes");
      },
    });
    h.store.set(entry.path, projectJson());
    // no audio bytes stored — the probe path never needs them
    await h.controller.openProject(entry);
    expect(byteReads).toBe(0);
    expect(h.screens).toEqual(["openingAudio", "audioReady"]);
    expect(h.readyAudios[0]?.mediaSource).toEqual({
      kind: "url",
      url: probe.playbackUrl,
    });
  });

  it("probe hash mismatch at the recorded path → SOURCE_MISSING (#230)", async () => {
    const h = makeHarness({
      probeAudio: async () => ({
        durationSeconds: 1,
        sampleRate: 48_000,
        channels: 2,
        sizeBytes: 1,
        contentHash: "hash-other",
        peaks: [0],
        playbackUrl: "u",
      }),
    });
    h.store.set(entry.path, projectJson());
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
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
      // #364: the failed MRU path rides the issue so the card can
      // offer 履歴から削除 and the launch auto-open can skip it.
      path: entry.path,
    });
    expect(h.screens.at(-1)).toBe("audioError");
  });

  it("a dropped .hornscribe.json opens as a project, not an audio error", async () => {
    const h = makeHarness();
    // kind:file ref — the browser-dev/drop path; the recorded source
    // is not on disk so the flow lands on SOURCE_MISSING honestly.
    const file = new File([await projectJson().text()], "etude.hornscribe.json");
    await h.controller.importRefs([{ kind: "file", file, name: file.name }]);
    const s = h.controller.getState();
    expect(s.phase).toBe("sourceMissing");
    expect(s.sourceMissing?.project.name).toBe("etude");
    // No durable path — the project must not enter the recents list.
    expect(h.recents).toHaveLength(0);
  });

  it("saved score extras → onProjectScoreReady restores without re-transcribing (#106)", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson({
      score: { revision: "rev-0123456789abcdef" },
      musicXmlConcert: "<score-partwise/>",
      musicXmlHornF: "<score-partwise/>",
      reviewIssues: [{ id: "ri-000001", reason: "low_model_confidence" }],
    }));
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));

    await h.controller.openProject(entry);

    expect(h.scoreResults).toHaveLength(1);
    const result = h.scoreResults[0] as Record<string, unknown>;
    expect(result.musicXmlConcert).toBe("<score-partwise/>");
    expect(result.scoreRevision).toBe("rev-0123456789abcdef");
    expect(result.reviewIssues).toHaveLength(1);
    expect(h.announcements.at(-1)).toContain("etude");
    // #221: the project's own path rides along so the host's Ctrl+S
    // saves back to it without a picker.
    expect(h.scoreProjectPaths).toEqual([entry.path]);
  });

  it("project without extras → no score event, AUDIO_READY only (#106)", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));
    await h.controller.openProject(entry);
    expect(h.scoreResults).toHaveLength(0);
    expect(h.screens.at(-1)).toBe("audioReady");
  });

  it("onProjectOpened fires before onAudioReady with saved settings (#264)", async () => {
    const h = makeHarness();
    const settings = { meter: "6/8", triplets: "always", backend: "basicPitch" };
    h.store.set(entry.path, projectJson({
      transcription: { revision: "tr-0123456789abcdef", settings },
    }));
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));
    await h.controller.openProject(entry);
    expect(h.openedProjects).toHaveLength(1);
    expect(h.openedProjects[0].transcriptionSettings).toEqual(settings);
    expect(h.readyAudios).toHaveLength(1);
    // #264: the project event must precede the audio event so the
    // host can stage options before the audio-slot reset reads them.
    expect(h.eventOrder.indexOf("projectOpened")).toBeLessThan(
      h.eventOrder.indexOf("audioReady"),
    );
  });

  it("SOURCE_MISSING still restores the score in the background (#106)", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson({
      score: { revision: "rev-0123456789abcdef" },
      musicXmlConcert: "x",
      musicXmlHornF: "y",
    }));
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
    expect(h.scoreResults).toHaveLength(1);
  });
});

describe("relinkWith — hash-validated relink (store.py relink_source_audio)", () => {

describe("openProject — engine-routed project.open (#365)", () => {
  const entry: RecentProjectEntry = {
    name: "etude",
    path: "C:\\p\\etude.hornscribe.json",
    openedAt: 1,
  };

  function eventsFor(h: ReturnType<typeof makeHarness>) {
    return {
      onScreenChange: (s: ScreenState) => h.screens.push(s),
      onState: () => {},
      announce: (m: string) => h.announcements.push(m),
      onRecentChange: () => {},
      onAudioReady: (a: (typeof h.readyAudios)[number]) =>
        h.readyAudios.push(a),
      onProjectScoreReady: (r: unknown, project: { path: string }) => {
        h.scoreResults.push(r);
        h.scoreProjects.push(project);
      },
    };
  }

  it("path opens inspect worker-side — bytes never enter the webview", async () => {
    const h = makeHarness();
    h.store.set(entry.path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));
    const calls: unknown[] = [];
    let byteReads = 0;
    const ports = {
      ...h.ports,
      readProjectBytes: async () => {
        byteReads += 1;
        throw new Error("must not read project bytes");
      },
      inspectProject: async (ref: { path: string }) => {
        calls.push(ref);
        const raw = await h.store.get(entry.path)!.text();
        return { path: entry.path, project: JSON.parse(raw) };
      },
    };
    const c = new ImportController(ports, eventsFor(h));
    await c.openProject(entry);
    expect(calls).toEqual([{ path: entry.path }]);
    expect(byteReads).toBe(0);
    expect(h.readyAudios).toHaveLength(1);
  });

  it("byte-opens ride documentBase64 through the same worker path", async () => {
    const h = makeHarness();
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));
    const refs: { documentBase64: string }[] = [];
    const ports = {
      ...h.ports,
      inspectProject: async (ref: { documentBase64: string }) => {
        refs.push(ref);
        const doc = JSON.parse(atob(ref.documentBase64));
        return { path: "", project: doc };
      },
    };
    const c = new ImportController(ports, eventsFor(h));
    const blob = projectJson();
    await c.openProject({ name: "dropped", path: "", openedAt: 1 }, blob);
    expect(refs).toHaveLength(1);
    expect(refs[0].documentBase64).toBe(await blobToBase64ForTest(blob));
    expect(h.readyAudios).toHaveLength(1);
  });

  it("worker rejection maps to projectOpenFailed with the path attached", async () => {
    const h = makeHarness();
    const ports = {
      ...h.ports,
      inspectProject: async () => {
        throw new Error("invalid project document: schemaVersion 99");
      },
    };
    const c = new ImportController(ports, eventsFor(h));
    await c.openProject(entry);
    expect(c.getState().phase).toBe("error");
    expect(c.getState().issue).toMatchObject({
      kind: "projectOpenFailed",
      fileName: "etude",
      path: entry.path,
    });
  });

  it("a .recovery restore flags the summary + announces the backup (#391)", async () => {
    const h = makeHarness();
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));
    const ports = {
      ...h.ports,
      inspectProject: async () => ({
        path: entry.path,
        project: JSON.parse(
          await projectJson({
            musicXmlConcert: "<score-partwise/>",
            musicXmlHornF: "<score-partwise horn/>",
          }).text(),
        ),
        recovered: true,
      }),
    };
    const c = new ImportController(ports, eventsFor(h));
    await c.openProject(entry);
    expect(h.readyAudios).toHaveLength(1);
    // The restored doc reaches the host with `recovered` so the
    // save baseline stays dirty — Ctrl+S repairs the main file.
    expect(h.scoreProjects).toEqual([
      expect.objectContaining({ path: entry.path, recovered: true }),
    ]);
    // The restore notice outranks the routine opened message.
    expect(h.announcements.at(-1)).toBe(
      ja.import.feedback.projectRecovered("etude"),
    );
  });
});

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

  it("path candidate verifies + streams via the native probe (#230)", async () => {
    const probe = {
      durationSeconds: 12.5,
      sampleRate: 48_000,
      channels: 2,
      sizeBytes: 42,
      contentHash: "hash-etude",
      peaks: [0.4],
      playbackUrl: "http://media.localhost/tok",
    };
    let byteReads = 0;
    const h = makeHarness({
      // The project's own recorded path probes as missing (drives
      // SOURCE_MISSING via the byte path); the relink candidate probes
      // with a matching hash.
      probeAudio: async (path) =>
        path === "C:\\audio\\etude.wav" ? null : probe,
      readAudioBytes: async () => {
        byteReads += 1;
        throw new Error("must not read bytes");
      },
    });
    await toSourceMissing(h);
    byteReads = 0; // count only the relink attempt
    await h.controller.relinkWith(pathRef("C:\\elsewhere\\etude.wav"));
    expect(byteReads).toBe(0);
    const s = h.controller.getState();
    expect(s.phase).toBe("ready");
    expect(s.audio?.mediaSource).toEqual({
      kind: "url",
      url: probe.playbackUrl,
    });
    expect(h.announcements.at(-1)).toContain("関連付け直");
  });

  it("probe hash mismatch on relink → SOURCE_MISSING mismatch=true (#230)", async () => {
    const h = makeHarness({
      probeAudio: async () => ({
        durationSeconds: 1,
        sampleRate: 48_000,
        channels: 2,
        sizeBytes: 1,
        contentHash: "hash-other",
        peaks: [0],
        playbackUrl: "u",
      }),
    });
    await toSourceMissing(h);
    await h.controller.relinkWith(pathRef("C:\\elsewhere\\nope.wav"));
    const s = h.controller.getState();
    expect(s.phase).toBe("sourceMissing");
    expect(s.sourceMissing?.mismatch).toBe(true);
  });

  it("SOURCE_MISSING → edit → relink: live score survives, new source path propagates (#367)", async () => {
    const h = makeHarness();
    // A score-bearing project whose source is gone — the saved extras
    // restore the score once, on entry.
    h.store.set(
      entry.path,
      projectJson({
        score: { revision: "rev-0123456789abcdef" },
        musicXmlConcert: "<score-partwise/>",
        musicXmlHornF: "<score-partwise horn/>",
      }),
    );
    await h.controller.openProject(entry);
    expect(h.controller.getState().phase).toBe("sourceMissing");
    expect(h.scoreResults).toHaveLength(1);

    // The user edits the restored score, then relinks to the file at
    // its new location (same content → hash verifies).
    h.store.set("C:\\elsewhere\\etude.wav", new Blob(["etude"]));
    await h.controller.relinkWith(pathRef("C:\\elsewhere\\etude.wav"));

    expect(h.controller.getState().phase).toBe("ready");
    // #367: audio reattached WITHOUT a second scoreResult event —
    // re-firing used to rebuild the ScoreDocument from the file and
    // silently discard the unsaved edits above.
    expect(h.scoreResults).toHaveLength(1);
    // The host gets the relink event carrying the verified new path.
    expect(h.relinkedProjects).toHaveLength(1);
    expect(h.relinkedProjects[0].sourcePath).toBe(
      "C:\\elsewhere\\etude.wav",
    );
    // The recordings-prune index tracks the live path immediately.
    expect(h.sourceRefUpdates.at(-1)).toEqual([
      entry.path,
      "C:\\elsewhere\\etude.wav",
    ]);
  });

  it("a failed relink retry does not clobber the live score either (#367)", async () => {
    const h = makeHarness();
    h.store.set(
      entry.path,
      projectJson({
        score: { revision: "rev-0123456789abcdef" },
        musicXmlConcert: "x",
        musicXmlHornF: "y",
      }),
    );
    await h.controller.openProject(entry);
    expect(h.scoreResults).toHaveLength(1);

    // Wrong candidate → the retry card re-enters sourceMissing, which
    // used to re-fire the saved score over the live document.
    await h.controller.relinkWith(fileRef("nope.wav", "nope"));
    expect(h.controller.getState().phase).toBe("sourceMissing");
    expect(h.controller.getState().sourceMissing?.mismatch).toBe(true);
    expect(h.scoreResults).toHaveLength(1);
    expect(h.relinkedProjects).toHaveLength(0);
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

describe("openProjectViaDialog (#369)", () => {
  it("cancel is silent — no state change, no announcement", async () => {
    const h = makeHarness();
    await h.controller.openProjectViaDialog();
    expect(h.states).toHaveLength(0);
    expect(h.screens).toHaveLength(0);
    expect(h.announcements).toHaveLength(0);
  });

  it("a picked project opens through the same verify funnel as recents", async () => {
    const path = "C:\\p\\etude.hornscribe.json";
    const h = makeHarness({
      pickProject: async () => pathRef(path, "etude.hornscribe.json"),
    });
    h.store.set(path, projectJson());
    h.store.set("C:\\audio\\etude.wav", new Blob(["etude"]));

    await h.controller.openProjectViaDialog();

    expect(h.screens).toEqual(["openingAudio", "audioReady"]);
    expect(h.readyAudios[0]?.fileName).toBe("etude.wav");
    // The picked project becomes the MRU head, same as a recents open.
    expect(h.recents.at(-1)?.[0]?.path).toBe(path);
  });

  it("picker rejection surfaces the open-failure issue, not a rejection", async () => {
    const h = makeHarness({
      pickProject: async () => {
        throw new Error("dialog broke");
      },
    });
    await h.controller.openProjectViaDialog();
    expect(h.controller.getState().issue).toMatchObject({
      kind: "openFailed",
    });
  });

  it("a picked non-project JSON gets the honest projectOpenFailed card", async () => {
    const path = "C:\\p\\not-a-project.json";
    const h = makeHarness({
      pickProject: async () => pathRef(path, "not-a-project.json"),
    });
    h.store.set(path, new Blob(["{}"]));

    await h.controller.openProjectViaDialog();

    const s = h.controller.getState();
    expect(s.phase).toBe("error");
    expect(s.issue).toMatchObject({ kind: "projectOpenFailed" });
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

  it("reassembles scoreResult from saved extras (#106)", () => {
    const p = parse({
      schemaVersion: 1,
      projectId: "x",
      sourceAudio: null,
      score: { revision: "rev-0123456789abcdef" },
      musicXmlConcert: "<a/>",
      musicXmlHornF: "<b/>",
      reviewIssues: [{ id: "ri-1" }],
      scoreDocument: { parts: [] },
      meta: { tempoBpm: 120 },
    });
    const result = p.scoreResult as Record<string, unknown>;
    expect(result).toMatchObject({
      musicXmlConcert: "<a/>",
      musicXmlHornF: "<b/>",
      scoreRevision: "rev-0123456789abcdef",
    });
    expect(result.reviewIssues).toHaveLength(1);
    expect(result.scoreDocument).toEqual({ parts: [] });
  });

  it("no MusicXML extras → scoreResult is null (#106)", () => {
    const p = parse({ schemaVersion: 1, projectId: "x", sourceAudio: null });
    expect(p.scoreResult).toBeNull();
  });

  it("extracts transcription.settings provenance (#264)", () => {
    const p = parse({
      schemaVersion: 1,
      projectId: "x",
      sourceAudio: null,
      transcription: {
        revision: "tr-0123456789abcdef",
        backend: "basicPitch",
        settings: { meter: "6/8", triplets: "always", minDurationQl: "1/8" },
      },
    });
    expect(p.transcriptionSettings).toEqual({
      meter: "6/8",
      triplets: "always",
      minDurationQl: "1/8",
    });
  });

  it("no transcription record → settings are null (#264)", () => {
    const p = parse({ schemaVersion: 1, projectId: "x", sourceAudio: null });
    expect(p.transcriptionSettings).toBeNull();
  });
});
