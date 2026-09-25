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

import { getShellInfo, isTauriRuntime } from "../tauri/bridge";
import { MockDiagnosticsPort } from "./mockPort";
import { detectTools, resolveToolWithOverride } from "./toolProbe";
import type { DiagnosticsInfo, ToolPathOverrides } from "./types";

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
 * Shell-only port: truthful about the app itself, honest `unknown`/`false`
 * for everything that needs the missing engine/fs bridge.
 */
export class ShellDiagnosticsPort implements DiagnosticsPort {
  async collect(overrides?: ToolPathOverrides): Promise<DiagnosticsInfo> {
    const shell = await getShellInfo();
    // Real detection exists (export.detect_tools) — report it instead
    // of the old blanket "unknown"; overrides verified via #363 probe.
    const tools = await detectTools();
    const [museScore, ffmpeg] = await Promise.all([
      resolveToolWithOverride(
        tools?.museScore ?? { status: "unknown" },
        overrides?.museScorePath,
      ),
      resolveToolWithOverride(
        tools?.ffmpeg ?? { status: "unknown" },
        overrides?.ffmpegPath,
      ),
    ]);
    return {
      appVersion: shell?.version ?? null,
      engine: null,
      protocolVersion: null,
      backend: null,
      tools: {
        ffmpeg,
        museScore,
        verovio: { status: "unknown" },
        wavesurfer: { status: "unknown" },
      },
      paths: { cache: null, logs: null },
      workerStatus: "unavailable",
    };
  }
  async copyText(text: string): Promise<boolean> {
    return clipboardWrite(text);
  }
  async openLogFolder(): Promise<boolean> {
    return false;
  }
  async restartEngine(): Promise<boolean> {
    return false;
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

export function createDefaultDiagnosticsPort(): DiagnosticsPort {
  if (isTauriRuntime()) return new ShellDiagnosticsPort();
  return MockDiagnosticsPort.withDevOverrides();
}
