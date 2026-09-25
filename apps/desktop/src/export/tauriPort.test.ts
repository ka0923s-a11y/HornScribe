// @vitest-environment jsdom
/**
 * TauriExportPort flow tests (#231/#258) — the Tauri invoke boundary is
 * mocked so the collision prompt and the transactional export_run call
 * are asserted as contracts, not side effects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TauriExportPort } from "./tauriPort";
import { createFixtureScoreDocument } from "../score/fixtureDocument";

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
