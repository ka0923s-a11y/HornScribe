/**
 * DiagnosticsPort contract tests (UI-060) — collect() is contractually
 * non-rejecting so the sheet can always render an honest picture; the
 * mock reports real-looking data labelled "(mock)" and honours the same
 * tool-path overrides as the export port.
 */

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockDiagnosticsPort } from "./mockPort";
import { ShellDiagnosticsPort } from "./port";
import { withPathOverride } from "./types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("MockDiagnosticsPort.collect", () => {
  it("populates the full §19 surface", async () => {
    const info = await new MockDiagnosticsPort({ latencyMs: 0 }).collect();
    expect(info.appVersion).toBeTruthy();
    expect(info.engine?.name).toContain("mock");
    expect(info.protocolVersion).toBe(1);
    expect(info.tools.ffmpeg.status).toBe("found");
    expect(info.tools.museScore.status).toBe("found");
    // Frontend libs are not integrated — reported honestly, not invented.
    expect(info.tools.verovio.status).toBe("unknown");
    expect(info.paths.cache).toBeTruthy();
    expect(info.paths.logs).toBeTruthy();
    expect(info.workerStatus).toBe("running");
  });

  it("honours 設定 → ツール path overrides", async () => {
    const info = await new MockDiagnosticsPort({
      latencyMs: 0,
      museScore: { status: "missing" },
    }).collect({ museScorePath: "D:\\ms\\MuseScore4.exe" });
    expect(info.tools.museScore).toMatchObject({
      status: "found",
      path: "D:\\ms\\MuseScore4.exe",
    });
  });

  it("actions never throw: openLogFolder is honest false in a browser", async () => {
    const port = new MockDiagnosticsPort({ latencyMs: 0 });
    await expect(port.openLogFolder()).resolves.toBe(false);
    await expect(port.restartEngine()).resolves.toBe(true);
  });
});

describe("ShellDiagnosticsPort.collect", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "shell_info") return { version: "1.2.3" };
      if (cmd === "detect_tools") {
        return {
          museScore: { status: "found", path: "MuseScore4" },
          ffmpeg: { status: "missing" },
        };
      }
      if (cmd === "probe_tool_path") return { status: "missing" };
      throw new Error("unexpected invoke " + cmd);
    });
  });

  it("reports real detect_tools results instead of blanket unknown", async () => {
    const info = await new ShellDiagnosticsPort().collect();
    expect(info.appVersion).toBe("1.2.3");
    expect(info.tools.museScore).toEqual({
      status: "found",
      path: "MuseScore4",
    });
    expect(info.tools.ffmpeg).toEqual({ status: "missing" });
  });

  it("a bogus user override reports missing — not a blind 検出済み (#363)", async () => {
    const info = await new ShellDiagnosticsPort().collect({
      ffmpegPath: "D:\\nope\\ffmpeg.exe",
    });
    expect(info.tools.ffmpeg.status).toBe("missing");
    expect(info.tools.ffmpeg.path).toBe("D:\\nope\\ffmpeg.exe");
  });

  it("detect_tools failure degrades to unknown, never rejects", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "shell_info") return { version: "1.2.3" };
      throw new Error("no probe");
    });
    const info = await new ShellDiagnosticsPort().collect();
    expect(info.tools.museScore.status).toBe("unknown");
    expect(info.tools.ffmpeg.status).toBe("unknown");
  });
});

describe("withPathOverride", () => {
  it("empty/blank overrides leave the probe result alone", () => {
    const probed = { status: "missing" as const };
    expect(withPathOverride(probed, undefined)).toBe(probed);
    expect(withPathOverride(probed, "")).toBe(probed);
    expect(withPathOverride(probed, "   ")).toBe(probed);
  });

  it("a non-empty override wins and flips status to found", () => {
    expect(
      withPathOverride({ status: "missing" }, "  C:\\ms.exe  "),
    ).toEqual({ status: "found", path: "C:\\ms.exe" });
  });
});
