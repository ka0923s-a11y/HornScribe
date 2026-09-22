/**
 * ExportPort contract tests (UI-060) — run against MockExportPort, the
 * same in-process fake the dialog uses in `vite dev`. The port boundary
 * is what a real engine implements later, so the mock's behaviour is the
 * contract: ENG-001 artifact names, typed ExportError codes (never raw
 * engine output), and honest capability gating.
 */

import { describe, expect, it } from "vitest";
import { MockExportPort } from "./mockPort";
import {
  ExportError,
  EXPORT_FORMAT_IDS,
  exportErrorCode,
  pdfBlocked,
  type ExportPort,
} from "./types";

function port(options?: ConstructorParameters<typeof MockExportPort>[0]) {
  return new MockExportPort({ latencyMs: 0, ...options });
}

describe("MockExportPort.export", () => {
  it("writes only the requested formats with ENG-001 artifact names", async () => {
    const res = await port().export({
      formats: ["hornMusicxml", "playbackMidi"],
      destination: "C:\\out",
      basename: "take1",
    });
    expect(res.destination).toBe("C:\\out");
    expect(res.files.map((f) => f.name)).toEqual([
      "take1_horn_in_f.musicxml",
      "take1_playback.mid",
    ]);
    expect(res.files.map((f) => f.path)).toEqual([
      "C:\\out\\take1_horn_in_f.musicxml",
      "C:\\out\\take1_playback.mid",
    ]);
  });

  it("keeps the canonical format order regardless of selection order", async () => {
    const res = await port().export({
      formats: [...EXPORT_FORMAT_IDS].reverse(),
      destination: "D:\\",
    });
    expect(res.files.map((f) => f.format)).toEqual(EXPORT_FORMAT_IDS);
  });

  it("rejects with a typed ExportError when nothing is selected", async () => {
    await expect(
      port().export({ formats: [], destination: "C:\\out" }),
    ).rejects.toMatchObject({ name: "ExportError", code: "EXPORT_FAILED" });
  });

  it("maps every injected failure to its stable code", async () => {
    for (const code of [
      "PERMISSION_DENIED",
      "ENGINE_UNAVAILABLE",
      "MUSESCORE_UNAVAILABLE",
      "EXPORT_FAILED",
    ] as const) {
      const err = await port({ failure: code })
        .export({ formats: ["playbackMidi"], destination: "C:\\out" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExportError);
      expect(exportErrorCode(err)).toBe(code);
    }
  });
});

describe("capabilities + pdf gate", () => {
  it("reports MuseScore found by default so PDF stays enabled", async () => {
    const caps = await port().capabilities();
    expect(caps.museScore.status).toBe("found");
    expect(pdfBlocked(caps)).toBe(false);
  });

  it("MuseScore missing blocks PDF only — other formats stay available", async () => {
    const caps = await port({ museScore: { status: "missing" } }).capabilities();
    expect(pdfBlocked(caps)).toBe(true);
    // The dialog's own filtering keeps score/midi formats enabled; the
    // gate never touches them.
    expect(caps.ffmpeg.status).toBe("found");
  });

  it("user-specified tool paths override probing (設定 → ツール)", async () => {
    const caps = await port({ museScore: { status: "missing" } }).capabilities({
      museScorePath: "D:\\MuseScore\\MuseScore4.exe",
    });
    expect(caps.museScore).toMatchObject({
      status: "found",
      path: "D:\\MuseScore\\MuseScore4.exe",
    });
    expect(pdfBlocked(caps)).toBe(false);
  });
});

describe("destination + reveal", () => {
  it("chooseDestination resolves a directory; reveal is honest false", async () => {
    const p: ExportPort = port({ defaultDestination: "C:\\Users\\me\\Documents" });
    await expect(p.chooseDestination()).resolves.toBe(
      "C:\\Users\\me\\Documents",
    );
    await expect(p.chooseDestination("E:\\picked")).resolves.toBe("E:\\picked");
    await expect(p.revealInExplorer("C:\\out")).resolves.toBe(false);
  });
});

describe("exportErrorCode", () => {
  it("collapses unknown throws to EXPORT_FAILED", () => {
    expect(exportErrorCode(new Error("boom"))).toBe("EXPORT_FAILED");
    expect(exportErrorCode("nope")).toBe("EXPORT_FAILED");
    expect(
      exportErrorCode(new ExportError("PERMISSION_DENIED", "x")),
    ).toBe("PERMISSION_DENIED");
  });
});
