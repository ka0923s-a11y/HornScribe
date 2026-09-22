/**
 * Shared capability / diagnostics types (UI-060).
 *
 * These mirror the sidecar handshake surface (`engine.handshake` →
 * `{protocolVersion, engineInfo, capabilities}` in protocol/PROTOCOL.md) so
 * a real engine can feed the same structures later — the TS side only needs
 * the contract surface today (issue: "export/backend capability reporting").
 * `src/sidecar/` (UI-040) owns the wire client; this file owns the
 * user-facing projection used by the export dialog, the settings tools
 * section and the diagnostics sheet.
 */

/** Engine identity from `engine.handshake` response `engineInfo`. */
export interface EngineInfo {
  readonly name: string;
  readonly version: string;
  readonly python?: string;
  readonly platform?: string;
  readonly pid?: number;
}

/** Detection state of an external tool (FFmpeg / MuseScore). */
export type ToolStatus = "found" | "missing" | "checking" | "unknown";

export interface ToolInfo {
  readonly status: ToolStatus;
  /** Resolved executable path when known (auto-detected or user-set). */
  readonly path?: string;
  readonly version?: string;
}

/**
 * Worker liveness as the shell sees it (never raw exit codes — the
 * supervisor vocabulary of ADR-0002: running / stopped / unavailable).
 */
export type WorkerStatus = "running" | "stopped" | "unavailable" | "unknown";

/** Everything the 診断情報 surface renders (GUI_UX_SPEC §19). */
export interface DiagnosticsInfo {
  /** App/shell version (`shell_info`); null when it cannot be read. */
  readonly appVersion: string | null;
  /** Engine handshake identity; null when the engine is not connected. */
  readonly engine: EngineInfo | null;
  readonly protocolVersion: number | null;
  /** Transcription backend id (e.g. "basic-pitch"); null when unknown. */
  readonly backend: string | null;
  /** External/bundled component status rows. */
  readonly tools: {
    readonly ffmpeg: ToolInfo;
    readonly museScore: ToolInfo;
    readonly verovio: ToolInfo;
    readonly wavesurfer: ToolInfo;
  };
  readonly paths: {
    readonly cache: string | null;
    readonly logs: string | null;
  };
  readonly workerStatus: WorkerStatus;
}

/** User-overridable tool paths (設定 → ツール). Empty string = auto-detect. */
export interface ToolPathOverrides {
  readonly museScorePath?: string;
  readonly ffmpegPath?: string;
}

/**
 * Merges a probed {@link ToolInfo} with a user-specified path: a non-empty
 * override wins (the user told us where the tool lives — the real probe
 * verifies it; until then the UI reports the override as the location).
 */
export function withPathOverride(
  probed: ToolInfo,
  overridePath: string | undefined,
): ToolInfo {
  const path = overridePath?.trim();
  if (!path) return probed;
  return { ...probed, status: "found", path };
}
