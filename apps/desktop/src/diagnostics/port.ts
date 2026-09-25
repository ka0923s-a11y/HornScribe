/**
 * DiagnosticsPort — data seam for the 診断情報 surface (UI-060;
 * GUI_UX_SPEC §19: versions / tool status / cache+log paths / actions).
 *
 * Same gate pattern as `src/sidecar/port.ts` (UI-040) and
 * `src/export/port.ts`: the shell renders whatever the port can honestly
 * report — `collect()` resolves with per-field `null`/`unknown` instead of
 * rejecting, so diagnostics stays usable even with no engine.
 *
 * Gate:
 * - plain browser → {@link MockDiagnosticsPort}: an in-process fake that
 *   populates every field so the full surface is reviewable in `vite dev`;
 * - Tauri webview → {@link ShellDiagnosticsPort}: reports shell-side truth
 *   (app version via `shell_info`, no engine/tool probe — there is no
 *   spawn/fs bridge yet), and the actions report honest failure rather
 *   than pretending.
 */

import { invoke } from "@tauri-apps/api/core";
import pkg from "../../package.json";
import { getShellInfo, isTauriRuntime } from "../tauri/bridge";
import { MockDiagnosticsPort } from "./mockPort";
import { detectTools, resolveToolWithOverride } from "./toolProbe";
import type {
  DiagnosticsInfo,
  EngineInfo,
  ToolPathOverrides,
  WorkerStatus,
} from "./types";

export interface DiagnosticsPort {
  /**
   * Gather the §19 surface. `overrides` carries the user-specified tool
   * paths from 設定 → ツール; non-empty paths override probing.
   * Never rejects: unavailable data is null/"unknown", so the sheet can
   * always render an honest picture.
   */
  collect(overrides?: ToolPathOverrides): Promise<DiagnosticsInfo>;
  /**
   * Copy already-formatted diagnostics text to the OS clipboard.
   * Resolves false when no clipboard path exists — the caller announces
   * the failure (clipboard may be absent/denied in some webviews).
   */
  copyText(text: string): Promise<boolean>;
  /** ログフォルダを開く — false when the bridge cannot reveal folders. */
  openLogFolder(): Promise<boolean>;
  /** エンジンを再起動 — false while no supervisor exists to restart. */
  restartEngine(): Promise<boolean>;
}

/**
 * Session-side view the shell port reports live (#403). The app wires
 * `sessionSnapshot` to `TranscriptionSession.getSnapshot()`; without it
 * the worker fields stay honest (unavailable) instead of inventing state.
 */
export interface DiagnosticsSessionView {
  readonly engine: string;
  /** Wire-shape engine identity (all fields optional on the protocol —
   *  the port fills display fallbacks when rendering). */
  readonly engineInfo: {
    readonly name?: string;
    readonly version?: string;
    readonly python?: string;
    readonly platform?: string;
    readonly pid?: number;
  } | null;
  readonly protocolVersion: number | null;
  /** Last completed job's result meta backend id; null before the first
   *  transcription. */
  readonly backend: string | null;
}

export interface ShellDiagnosticsDeps {
  /** Live view of the sidecar session (worker liveness, engine identity,
   *  negotiated protocol version, last backend). */
  sessionSnapshot?: () => DiagnosticsSessionView | null;
  /** エンジンを再起動 — TranscriptionSession.restartEngine in the shell. */
  restartEngine?: () => Promise<unknown>;
}

interface DiagnosticsPathsWire {
  cache: string;
  logs: string;
}

async function diagnosticsPaths(): Promise<DiagnosticsPathsWire | null> {
  try {
    return await invoke<DiagnosticsPathsWire>("diagnostics_paths");
  } catch {
    return null;
  }
}

/** ADR-0002 worker vocabulary: supervised-but-idle (offline, never
 *  started) maps to stopped; unavailable is reserved for "the port has
 *  no session to ask". */
function toWorkerStatus(engine: string): WorkerStatus {
  switch (engine) {
    case "ready":
    case "starting":
      return "running";
    case "offline":
    case "crashed":
    case "unresponsive":
    case "closed":
      return "stopped";
    default:
      return "unavailable";
  }
}

/** Wire → §19 row: the sheet renders name/version unconditionally, so
 *  missing fields get honest placeholders rather than "undefined". */
function toEngineInfo(
  info: DiagnosticsSessionView["engineInfo"],
): EngineInfo | null {
  if (!info) return null;
  return {
    name: info.name ?? "hornscribe-engine",
    version: info.version ?? "?",
    ...(info.python !== undefined ? { python: info.python } : {}),
    ...(info.platform !== undefined ? { platform: info.platform } : {}),
    ...(info.pid !== undefined ? { pid: info.pid } : {}),
  };
}

// verovio is a bundled, actively-used dependency (src/score/verovio.ts) —
// the declared version in package.json is the shipped one, so the row
// can report found instead of unknown (#403).
const VEROVIO_VERSION = pkg.dependencies.verovio;

/**
 * Shell port: app-shell truth (version, tool probes, cache/log paths)
 * plus whatever the wired session honestly reports. Every bridge call
 * degrades per-field to null/"unknown" rather than rejecting.
 */
export class ShellDiagnosticsPort implements DiagnosticsPort {
  constructor(private readonly deps: ShellDiagnosticsDeps = {}) {}

  async collect(overrides?: ToolPathOverrides): Promise<DiagnosticsInfo> {
    const shell = await getShellInfo();
    // Real detection exists (export.detect_tools) — report it instead
    // of the old blanket "unknown"; overrides verified via #363 probe.
    const tools = await detectTools();
    const view = this.deps.sessionSnapshot?.() ?? null;
    const [museScore, ffmpeg, paths] = await Promise.all([
      resolveToolWithOverride(
        tools?.museScore ?? { status: "unknown" },
        overrides?.museScorePath,
      ),
      resolveToolWithOverride(
        tools?.ffmpeg ?? { status: "unknown" },
        overrides?.ffmpegPath,
      ),
      diagnosticsPaths(),
    ]);
    return {
      appVersion: shell?.version ?? null,
      engine: toEngineInfo(view?.engineInfo ?? null),
      protocolVersion: view?.protocolVersion ?? null,
      backend: view?.backend ?? null,
      tools: {
        ffmpeg,
        museScore,
        verovio: { status: "found", version: VEROVIO_VERSION },
        // The waveform is a custom SVG renderer — no wavesurfer dep to
        // report, so unknown stays the honest answer.
        wavesurfer: { status: "unknown" },
      },
      paths: paths ?? { cache: null, logs: null },
      workerStatus: view ? toWorkerStatus(view.engine) : "unavailable",
    };
  }
  async copyText(text: string): Promise<boolean> {
    return clipboardWrite(text);
  }
  async openLogFolder(): Promise<boolean> {
    try {
      await invoke("reveal_log_folder");
      return true;
    } catch {
      return false;
    }
  }
  async restartEngine(): Promise<boolean> {
    if (!this.deps.restartEngine) return false;
    try {
      await this.deps.restartEngine();
      return true;
    } catch {
      return false;
    }
  }
}

/** Clipboard write shared by both ports (browser + webview). */
export async function clipboardWrite(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function createDefaultDiagnosticsPort(
  deps?: ShellDiagnosticsDeps,
): DiagnosticsPort {
  if (isTauriRuntime()) return new ShellDiagnosticsPort(deps);
  return MockDiagnosticsPort.withDevOverrides();
}
