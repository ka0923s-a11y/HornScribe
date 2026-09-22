/**
 * 診断情報をコピー — plain-text rendering of {@link DiagnosticsInfo}
 * (GUI_UX_SPEC §19). Japanese labels come from the copy deck values in
 * strings/ja.ts so the pasted report uses the same terms as the UI.
 * Values only — never stack traces or engine stderr.
 */

import { ja } from "../strings/ja";
import type { DiagnosticsInfo, ToolInfo, WorkerStatus } from "./types";

function toolLine(info: ToolInfo): string {
  const s = ja.dependencies;
  const status =
    info.status === "found"
      ? s.statusFound
      : info.status === "missing"
        ? s.statusMissing
        : info.status === "checking"
          ? s.statusChecking
          : ja.diagnostics.unknown;
  const extras = [info.version, info.path].filter(Boolean).join(" — ");
  return extras ? `${status}（${extras}）` : status;
}

function workerLine(status: WorkerStatus): string {
  const d = ja.diagnostics.workerStates;
  return status === "running"
    ? d.running
    : status === "stopped"
      ? d.stopped
      : status === "unavailable"
        ? d.unavailable
        : ja.diagnostics.unknown;
}

function value(v: string | number | null | undefined): string {
  return v == null || v === "" ? ja.diagnostics.notConnected : String(v);
}

/** One "ラベル: 値" per line — paste-ready for issue reports. */
export function formatDiagnosticsText(info: DiagnosticsInfo): string {
  const f = ja.diagnostics.fields;
  const lines: [string, string][] = [
    [f.appVersion, value(info.appVersion)],
    [
      f.engineVersion,
      info.engine ? `${info.engine.name} ${info.engine.version}` : value(null),
    ],
    [f.protocolVersion, value(info.protocolVersion)],
    [f.backend, value(info.backend)],
    [f.ffmpeg, toolLine(info.tools.ffmpeg)],
    [f.musescore, toolLine(info.tools.museScore)],
    [f.verovio, toolLine(info.tools.verovio)],
    [f.wavesurfer, toolLine(info.tools.wavesurfer)],
    [f.cachePath, value(info.paths.cache)],
    [f.logPath, value(info.paths.logs)],
    [f.workerStatus, workerLine(info.workerStatus)],
  ];
  return lines.map(([k, v]) => `${k}: ${v}`).join("\n");
}
