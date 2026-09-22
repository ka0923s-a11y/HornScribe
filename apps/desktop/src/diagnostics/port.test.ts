/**
 * DiagnosticsPort contract tests (UI-060) — collect() is contractually
 * non-rejecting so the sheet can always render an honest picture; the
 * mock reports real-looking data labelled "(mock)" and honours the same
 * tool-path overrides as the export port.
 */

import { describe, expect, it } from "vitest";
import { MockDiagnosticsPort } from "./mockPort";
import { withPathOverride } from "./types";

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
