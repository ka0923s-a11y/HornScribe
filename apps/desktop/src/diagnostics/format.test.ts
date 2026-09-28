/**
 * 診断情報をコピー formatting tests (UI-060). The copied text is the same
 * Japanese vocabulary the sheet renders; unavailable fields read 未接続 —
 * never empty, never a stack trace.
 */

import { describe, expect, it } from "vitest";
import { ja } from "../strings/ja";
import { formatDiagnosticsText } from "./format";
import type { DiagnosticsInfo } from "./types";

const FULL: DiagnosticsInfo = {
  appVersion: "0.1.0",
  engine: { name: "hornscribe-engine", version: "0.1.0", python: "3.12" },
  protocolVersion: 1,
  backend: "basic-pitch",
  tools: {
    ffmpeg: { status: "found", path: "C:\\tools\\ffmpeg.exe", version: "7.x" },
    museScore: { status: "missing" },
    demucs: { status: "missing" },
    verovio: { status: "unknown" },
    wavesurfer: { status: "checking" },
  },
  paths: { cache: "C:\\cache", logs: "C:\\logs" },
  workerStatus: "running",
  timingCorrection: { shiftSec: 0.0124, meterResolved: true },
};

const EMPTY: DiagnosticsInfo = {
  appVersion: null,
  engine: null,
  protocolVersion: null,
  backend: null,
  tools: {
    ffmpeg: { status: "unknown" },
    museScore: { status: "unknown" },
    demucs: { status: "unknown" },
    verovio: { status: "unknown" },
    wavesurfer: { status: "unknown" },
  },
  paths: { cache: null, logs: null },
  workerStatus: "unavailable",
  timingCorrection: null,
};

describe("formatDiagnosticsText", () => {
  it("renders every field label exactly once", () => {
    const text = formatDiagnosticsText(FULL);
    for (const label of Object.values(ja.diagnostics.fields)) {
      expect(text).toContain(`${label}:`);
    }
    expect(text.split("\n")).toHaveLength(
      Object.keys(ja.diagnostics.fields).length,
    );
  });

  it("includes tool status, version and path for found tools", () => {
    const text = formatDiagnosticsText(FULL);
    expect(text).toContain(ja.dependencies.statusFound);
    expect(text).toContain("7.x");
    expect(text).toContain("C:\\tools\\ffmpeg.exe");
  });

  it("maps every tool/worker status to Japanese vocabulary", () => {
    const text = formatDiagnosticsText(FULL);
    expect(text).toContain(ja.dependencies.statusMissing);
    expect(text).toContain(ja.dependencies.statusChecking);
    expect(text).toContain(ja.diagnostics.unknown);
    expect(text).toContain(ja.diagnostics.workerStates.running);
  });

  it("reports unavailable data as 未接続 instead of failing", () => {
    const text = formatDiagnosticsText(EMPTY);
    expect(text).toContain(ja.diagnostics.notConnected);
    expect(text).toContain(ja.diagnostics.workerStates.unavailable);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  it("renders the applied timing correction with its resolved tag (#81)", () => {
    const text = formatDiagnosticsText(FULL);
    expect(text).toContain(`${ja.diagnostics.fields.timingCorrection}: +12.4 ms`);
    expect(text).toContain(ja.diagnostics.timingCorrectionResolved);
  });

  it("omits the timing-correction line when none was applied (#81)", () => {
    const text = formatDiagnosticsText(EMPTY);
    expect(text).not.toContain(ja.diagnostics.fields.timingCorrection);
  });

  it("an unresolved correction carries no tag", () => {
    const text = formatDiagnosticsText({
      ...FULL,
      timingCorrection: { shiftSec: -0.0308, meterResolved: false },
    });
    expect(text).toContain(
      `${ja.diagnostics.fields.timingCorrection}: -30.8 ms`,
    );
    expect(text).not.toContain(ja.diagnostics.timingCorrectionResolved);
  });
});
