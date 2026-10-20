// @vitest-environment jsdom
/**
 * TauriExportPort flow tests (#231/#258) — the Tauri invoke boundary is
 * mocked so the collision prompt and the transactional export_run call
 * are asserted as contracts, not side effects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TauriExportPort } from "./tauriPort";
import { createFixtureScoreDocument } from "../score/fixtureDocument";
import type { ScoreDocumentPort } from "../score/document";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function source() {
  return {
    doc: createFixtureScoreDocument(),
    basename: "take1",
    audioPath: "C:\\audio\\take.wav",
    audioName: "take.wav",
  };
}

function port() {
  return new TauriExportPort(source);
}

function canonicalSource() {
  return {
    doc: createFixtureScoreDocument({
      canonicalDocument: { schemaVersion: 1, notes: [] },
    }),
    basename: "take1",
    audioPath: null,
    audioName: null,
  };
}

describe("TauriExportPort.export", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") return [];
      if (cmd === "export_run") {
        return [
          "C:\\out\\take1_source.wav",
          "C:\\out\\take1_concert.musicxml",
        ];
      }
      if (cmd === "detect_tools") {
        return { museScore: { status: "missing" }, ffmpeg: { status: "missing" } };
      }
      throw new Error("unexpected invoke " + cmd);
    });
  });

  it("writes through one transactional export_run call", async () => {
    const res = await port().export({
      formats: ["concertMusicxml", "sourceAudio"],
      destination: "C:\\out",
      basename: "take1",
    });
    const run = invokeMock.mock.calls.find((c) => c[0] === "export_run");
    expect(run).toBeTruthy();
    expect(run?.[1]).toMatchObject({
      dir: "C:\\out",
      audio: { name: "take1_source.wav", src: "C:\\audio\\take.wav" },
      musescorePath: null,
    });
    expect(res.files.map((f) => f.name)).toEqual([
      "take1_concert.musicxml",
      "take1_source.wav",
    ]);
  });

  it("asks onCollision once when names already exist (#231)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") {
        return ["take1_concert.musicxml"];
      }
      if (cmd === "export_run") return ["C:\\out\\take1_concert.musicxml"];
      throw new Error("unexpected " + cmd);
    });
    const seen: string[][] = [];
    await port().export({
      formats: ["concertMusicxml"],
      destination: "C:\\out",
      basename: "take1",
      onCollision: async (names) => {
        seen.push([...names]);
        return "overwrite";
      },
    });
    expect(seen).toEqual([["take1_concert.musicxml"]]);
    expect(invokeMock.mock.calls.some((c) => c[0] === "export_run")).toBe(true);
  });

  it("rename re-stems the whole set until the check is clear (#231)", async () => {
    const checks: string[][] = [];
    invokeMock.mockImplementation(async (cmd: string, args: { names?: string[] }) => {
      if (cmd === "export_check_existing") {
        checks.push([...(args.names ?? [])]);
        return args.names?.every((n) => n.startsWith("take1_2_")) ? [] : [args.names?.[0]];
      }
      if (cmd === "export_run") return ["C:\\out\\take1_2_concert.musicxml"];
      throw new Error("unexpected " + cmd);
    });
    const res = await port().export({
      formats: ["concertMusicxml"],
      destination: "C:\\out",
      basename: "take1",
      onCollision: async () => "rename",
    });
    expect(res.files[0].name).toBe("take1_2_concert.musicxml");
    expect(checks.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel surfaces EXPORT_CANCELLED and never runs (#231)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") return ["take1_concert.musicxml"];
      if (cmd === "export_run") throw new Error("must not run");
      throw new Error("unexpected " + cmd);
    });
    await expect(
      port().export({
        formats: ["concertMusicxml"],
        destination: "C:\\out",
        basename: "take1",
        onCollision: async () => "cancel",
      }),
    ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "export_run")).toBe(false);
  });

  it("PDF without MuseScore fails before export_run (#258)", async () => {
    await expect(
      port().export({
        formats: ["concertPdf"],
        destination: "C:\\out",
      }),
    ).rejects.toMatchObject({ code: "MUSESCORE_UNAVAILABLE" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "export_run")).toBe(false);
  });

  it("abort during the run fires export_cancel with the matching exportId (#383)", async () => {
    let runId = "";
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "export_check_existing") return [];
      if (cmd === "export_run") {
        runId = (args as { exportId: string }).exportId;
        // The Rust side notices the flag and rejects cancelled —
        // simulate the same outcome the real command produces.
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("EXPORT_CANCELLED");
      }
      if (cmd === "export_cancel") return null;
      throw new Error("unexpected " + cmd);
    });
    const controller = new AbortController();
    const pending = port().export(
      { formats: ["concertMusicxml"], destination: "C:\\out" },
      controller.signal,
    );
    // Wait until the transactional call is actually in flight.
    for (let i = 0; i < 100 && !runId; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "EXPORT_CANCELLED",
    });
    const cancel = invokeMock.mock.calls.find((c) => c[0] === "export_cancel");
    expect(runId).not.toBe("");
    expect(cancel?.[1]).toEqual({ exportId: runId });
  });

  it("a pre-aborted signal rejects EXPORT_CANCELLED without the bridge (#383)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      port().export(
        { formats: ["concertMusicxml"], destination: "C:\\out" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "export_run")).toBe(
      false,
    );
  });

  // #384: the Rust side tags every failure `CODE: detail` — the
  // prefix alone selects the recovery surface; untagged errors still
  // collapse to EXPORT_FAILED.
  it.each([
    ["EXPORT_DISK_FULL: write C:\\out\\take.mid: os error 112", "EXPORT_DISK_FULL"],
    ["EXPORT_SOURCE_MISSING: C:\\audio\\take.wav", "EXPORT_SOURCE_MISSING"],
    ["EXPORT_MUSESCORE_RENDER_FAILED: MuseScore exited with exit code: 1", "EXPORT_MUSESCORE_RENDER_FAILED"],
    ["EXPORT_DESTINATION_INVALID: not a directory: C:\\x", "EXPORT_DESTINATION_INVALID"],
    ["EXPORT_COMMIT_FAILED: write C:\\out\\take.mid: os error 5", "EXPORT_COMMIT_FAILED"],
    ["EXPORT_WRITE_FAILED: stage C:\\tmp\\h: os error 123", "EXPORT_WRITE_FAILED"],
    ["EXPORT_NAME_INVALID: ../evil", "EXPORT_NAME_INVALID"],
    ["EXPORT_INTERNAL: take.mid: bad base64 byte", "EXPORT_INTERNAL"],
    ["PERMISSION_DENIED", "PERMISSION_DENIED"],
    ["PERMISSION_DENIED: create C:\\out: os error 5", "PERMISSION_DENIED"],
    ["write C:\\out\\take.mid: os error 1", "EXPORT_FAILED"],
    ["MuseScore exited with exit code: 1", "EXPORT_FAILED"],
  ])("export_run rejection %j maps to %s", async (message, code) => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") return [];
      if (cmd === "export_run") throw new Error(message);
      throw new Error("unexpected " + cmd);
    });
    await expect(
      port().export({
        formats: ["concertMusicxml"],
        destination: "C:\\out",
      }),
    ).rejects.toMatchObject({ code });
  });
});

describe("TauriExportPort.capabilities", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "detect_tools") {
        return { museScore: { status: "missing" }, ffmpeg: { status: "missing" } };
      }
      if (cmd === "probe_tool_path") return { status: "found", path: "D:\\ms.exe" };
      throw new Error("unexpected invoke " + cmd);
    });
  });

  it("a verified override reports found (#363)", async () => {
    const caps = await port().capabilities({ museScorePath: "D:\\ms.exe" });
    expect(caps.museScore).toEqual({ status: "found", path: "D:\\ms.exe" });
    expect(invokeMock).toHaveBeenCalledWith("probe_tool_path", {
      path: "D:\\ms.exe",
    });
  });

  it("a bogus override reports missing instead of a blind 検出済み (#363)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "detect_tools") {
        return { museScore: { status: "missing" }, ffmpeg: { status: "missing" } };
      }
      if (cmd === "probe_tool_path") return { status: "missing" };
      throw new Error("unexpected invoke " + cmd);
    });
    const caps = await port().capabilities({ museScorePath: "D:\\nope.exe" });
    expect(caps.museScore.status).toBe("missing");
    expect(caps.museScore.path).toBe("D:\\nope.exe");
  });
});

/* #390: a dead/failing canonical-MIDI engine degrades that ONE
 *  format — the transaction and every other format survives. */
describe("TauriExportPort MIDI resilience (#390)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") return [];
      if (cmd === "export_run") {
        return [
          "C:\\out\\take1_concert.musicxml",
          "C:\\out\\take1_playback.mid",
        ];
      }
      if (cmd === "detect_tools") {
        return { museScore: { status: "missing" }, ffmpeg: { status: "missing" } };
      }
      throw new Error("unexpected invoke " + cmd);
    });
  });

  it("degrades MIDI alone when the engine RPC fails", async () => {
    const midiExporter = vi.fn(() =>
      Promise.reject(new Error("engine exploded")),
    );
    const p = new TauriExportPort(canonicalSource, midiExporter);
    const res = await p.export({
      formats: ["concertMusicxml", "playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(invokeMock.mock.calls.some((c) => c[0] === "export_run")).toBe(
      true,
    );
    expect(res.files.map((f) => f.format).sort()).toEqual([
      "concertMusicxml",
      "playbackMidi",
    ]);
    expect(res.degraded).toEqual(["playbackMidi"]);
    const run = invokeMock.mock.calls.find((c) => c[0] === "export_run");
    const files = (run?.[1] as { files: { name: string }[] }).files;
    expect(files.some((f) => f.name.endsWith(".mid"))).toBe(true);
  });

  it("skips the doomed RPC entirely when the engine is known down (#390)", async () => {
    const midiExporter = vi.fn(() => Promise.resolve("AAAA"));
    const p = new TauriExportPort(
      canonicalSource,
      midiExporter,
      () => false,
    );
    const res = await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(midiExporter).not.toHaveBeenCalled();
    expect(res.degraded).toEqual(["playbackMidi"]);
  });

  it("produces canonical MIDI without a degraded flag when the engine answers", async () => {
    const midiExporter = vi.fn(() => Promise.resolve("AAAA"));
    const p = new TauriExportPort(canonicalSource, midiExporter);
    const res = await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(midiExporter).toHaveBeenCalledTimes(1);
    expect(res.degraded).toBeUndefined();
  });

  // #405: the mixer mute/solo is the audition contract — a part the
  // user cannot hear must not appear in the MIDI bounce.
  it("drops mixer-muted parts from the canonical MIDI payload (#405)", async () => {
    const midiExporter = vi.fn<(doc: unknown) => Promise<string>>(() =>
      Promise.resolve("AAAA"),
    );
    const src = () => ({
      doc: createFixtureScoreDocument({
        canonicalDocument: {
          schemaVersion: 1,
          content: { parts: [{ name: "horn" }, { name: "accomp" }] },
        },
      }),
      basename: "take1",
      audioPath: null,
      audioName: null,
      partAudible: [true, false],
    });
    const p = new TauriExportPort(src, midiExporter);
    await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(midiExporter).toHaveBeenCalledTimes(1);
    const sent = midiExporter.mock.calls[0]?.[0] as {
      content: { parts: { name: string }[] };
    };
    expect(sent.content.parts.map((pt) => pt.name)).toEqual(["horn"]);
  });

  it("keeps hidden-but-audible parts in MIDI (#405)", async () => {
    const midiExporter = vi.fn<(doc: unknown) => Promise<string>>(() =>
      Promise.resolve("AAAA"),
    );
    const src = () => ({
      doc: createFixtureScoreDocument({
        canonicalDocument: {
          schemaVersion: 1,
          content: { parts: [{ name: "horn" }, { name: "accomp" }] },
        },
      }),
      basename: "take1",
      audioPath: null,
      audioName: null,
      // Hidden from notation but still audible — visibility is a
      // notation filter, so the MIDI bounce keeps the part.
      partVisible: [true, false],
      partAudible: [true, true],
    });
    const p = new TauriExportPort(src, midiExporter);
    await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    const sent = midiExporter.mock.calls[0]?.[0] as {
      content: { parts: { name: string }[] };
    };
    expect(sent.content.parts).toHaveLength(2);
  });

  it("fails open when the mute mask would empty the MIDI (#405)", async () => {
    const midiExporter = vi.fn<(doc: unknown) => Promise<string>>(() =>
      Promise.resolve("AAAA"),
    );
    const src = () => ({
      doc: createFixtureScoreDocument({
        canonicalDocument: {
          schemaVersion: 1,
          content: { parts: [{ name: "horn" }, { name: "accomp" }] },
        },
      }),
      basename: "take1",
      audioPath: null,
      audioName: null,
      partAudible: [false, false],
    });
    const p = new TauriExportPort(src, midiExporter);
    await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    const sent = midiExporter.mock.calls[0]?.[0] as {
      content: { parts: { name: string }[] };
    };
    // A zero-note artifact is never produced — same guard as the
    // score view refusing to render an empty score.
    expect(sent.content.parts).toHaveLength(2);
  });

  // #407: the fader half of the audition contract — gains index the
  // ORIGINAL part order, so dropping a muted part must shift the
  // surviving gains or a later part inherits an earlier fader.
  it("forwards audible-filtered part gains to the canonical MIDI (#407)", async () => {
    const midiExporter = vi.fn<
      (doc: unknown, opts?: { partGains?: readonly number[] }) => Promise<string>
    >(() => Promise.resolve("AAAA"));
    const src = () => ({
      doc: createFixtureScoreDocument({
        canonicalDocument: {
          schemaVersion: 1,
          content: { parts: [{ name: "horn" }, { name: "accomp" }] },
        },
      }),
      basename: "take1",
      audioPath: null,
      audioName: null,
      partAudible: [false, true],
      partGains: [0.2, 0.7],
    });
    const p = new TauriExportPort(src, midiExporter);
    await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(midiExporter).toHaveBeenCalledTimes(1);
    const sent = midiExporter.mock.calls[0]?.[0] as {
      content: { parts: { name: string }[] };
    };
    expect(sent.content.parts.map((pt) => pt.name)).toEqual(["accomp"]);
    // Only the surviving part's gain reaches the engine — the muted
    // lead's 0.2 must not slide onto the accompaniment.
    expect(midiExporter.mock.calls[0]?.[1]).toEqual({
      partGains: [0.7],
    });
  });

  it("omits partGains when the source has none (#407)", async () => {
    const midiExporter = vi.fn<
      (doc: unknown, opts?: { partGains?: readonly number[] }) => Promise<string>
    >(() => Promise.resolve("AAAA"));
    const p = new TauriExportPort(canonicalSource, midiExporter);
    await p.export({
      formats: ["playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(midiExporter.mock.calls[0]?.[1]).toEqual({
      partGains: undefined,
    });
  });

  it("reports the playbackMidi capability tier honestly (#390)", async () => {
    const ready = new TauriExportPort(
      canonicalSource,
      () => Promise.resolve("AAAA"),
      () => true,
    );
    expect((await ready.capabilities()).playbackMidi).toBe("canonical");

    const down = new TauriExportPort(
      canonicalSource,
      () => Promise.resolve("AAAA"),
      () => false,
    );
    expect((await down.capabilities()).playbackMidi).toBe("degraded");

    const docless = new TauriExportPort(() => null);
    expect((await docless.capabilities()).playbackMidi).toBe("unavailable");
  });
});


/* #236: file exports must mirror the visible part subset — the same
 * filterScorePartsXml the view and the print path apply. A hidden
 * staff must not reappear in MusicXML/PDF artifacts or in the
 * MuseScore hand-off. */
const THREE_PART_XML =
  '<?xml version="1.0"?>' +
  '<score-partwise version="4.0">' +
  "<part-list>" +
  '<score-part id="P1"><part-name>Horn in F</part-name></score-part>' +
  '<score-part id="P2"><part-name>伴奏</part-name></score-part>' +
  '<score-part id="P3"><part-name>伴奏 2</part-name></score-part>' +
  "</part-list>" +
  '<part id="P1"><measure number="1"><note id="hs-sn-000001-1"/></measure></part>' +
  '<part id="P2"><measure number="1"><note id="hs-sn-000010-1"/></measure></part>' +
  '<part id="P3"><measure number="1"><note id="hs-sn-000020-1"/></measure></part>' +
  "</score-partwise>";

function threePartDoc(): ScoreDocumentPort {
  return {
    revisionId: "rev-parts",
    editVersion: 0,
    meta: {
      title: "three",
      composer: null,
      arranger: null,
      tempoBpm: null,
      meter: null,
      pickupBeats: null,
      keyFifths: null,
      keyChanges: [],
      tempoChanges: [],
      keyMode: null,
      swingFeel: false,
      omittedIssueCount: 0,
      measureCount: 0,
      noteCount: 0,
    },
    musicXml: () => THREE_PART_XML,
    reviewIssues: () => [],
    recordReviewDecision: () => undefined,
    noteEdits: () => new Map(),
    setNoteEdit: () => undefined,
  };
}

function decodeXml(b64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
  );
}

describe("TauriExportPort part-visibility filter (#236)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "export_check_existing") return [];
      if (cmd === "export_run") {
        return ["C:\\out\\take1_concert.musicxml"];
      }
      if (cmd === "detect_tools") {
        return {
          museScore: { status: "found", path: "D:\\ms.exe" },
          ffmpeg: { status: "missing" },
        };
      }
      if (cmd === "open_in_musescore") return "C:\\tmp\\score.musicxml";
      throw new Error("unexpected invoke " + cmd);
    });
  });

  it("MusicXML export drops hidden staves like view and print do", async () => {
    const p = new TauriExportPort(() => ({
      doc: threePartDoc(),
      basename: "take1",
      audioPath: null,
      audioName: null,
      partVisible: [true, false, false],
    }));
    await p.export({
      formats: ["concertMusicxml"],
      destination: "C:\\out",
      basename: "take1",
    });
    const run = invokeMock.mock.calls.find((c) => c[0] === "export_run");
    const files = (run?.[1] as { files: { dataBase64: string }[] }).files;
    const xml = decodeXml(files[0].dataBase64);
    expect(xml).toContain("hs-sn-000001-1");
    expect(xml).not.toContain("hs-sn-000010-1");
    expect(xml).not.toContain("hs-sn-000020-1");
    expect((xml.match(/<score-part id=/g) ?? []).length).toBe(1);
  });

  it("all-visible and absent masks export the document untouched", async () => {
    for (const partVisible of [[true, true, true], undefined] as const) {
      const p = new TauriExportPort(() => ({
        doc: threePartDoc(),
        basename: "take1",
        audioPath: null,
        audioName: null,
        partVisible,
      }));
      await p.export({
        formats: ["concertMusicxml"],
        destination: "C:\\out",
        basename: "take1",
      });
    }
    const runs = invokeMock.mock.calls.filter(
      (c) => c[0] === "export_run",
    );
    expect(runs.length).toBe(2);
    for (const run of runs) {
      const files = (run[1] as { files: { dataBase64: string }[] }).files;
      const xml = decodeXml(files[0].dataBase64);
      expect(xml).toContain("hs-sn-000010-1");
    }
  });

  it("openInMuseScore hands over the visible subset too", async () => {
    const p = new TauriExportPort(() => ({
      doc: threePartDoc(),
      basename: "take1",
      audioPath: null,
      audioName: null,
      partVisible: [true, false, true],
    }));
    await p.openInMuseScore("hornF");
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "open_in_musescore",
    );
    const xml = (call?.[1] as { musicXml: string }).musicXml;
    expect(xml).toContain("hs-sn-000001-1");
    expect(xml).not.toContain("hs-sn-000010-1");
    expect(xml).toContain("hs-sn-000020-1");
  });
});


