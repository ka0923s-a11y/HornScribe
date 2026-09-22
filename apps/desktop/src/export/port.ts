/**
 * ExportPort — the seam between the 書き出し dialog and a concrete export
 * backend (UI-060).
 *
 * Same gate pattern as `src/sidecar/port.ts` (UI-040): the port owns the
 * capability probe and the export job, never the dialog logic; a real
 * implementation will wrap the sidecar client once the engine spawn bridge
 * lands, feeding `engine.handshake` capabilities into
 * {@link ExportCapabilities} (methods/jobKinds → supported formats,
 * engineInfo → diagnostics parity).
 *
 * ## Packaged-app gate
 *
 * No real spawn path exists yet: `src-tauri/capabilities/default.json`
 * grants no process/shell plugin permissions and no Rust supervisor is
 * wired. So `createDefaultExportPort()` returns:
 *
 * - {@link MockExportPort} in a plain browser (`vite dev` / vitest) — an
 *   in-process fake that exercises the full §17 flow including
 *   MuseScore-missing and permission-error recovery;
 * - {@link UnsupportedExportPort} inside the Tauri webview — every call
 *   fails explicitly with ENGINE_UNAVAILABLE, which the dialog maps to the
 *   honest 採譜エンジンに接続できません surface (診断情報 / 閉じる recovery),
 *   never a silent mock in the product shell.
 */

import { isTauriRuntime } from "../tauri/bridge";
import { MockExportPort } from "./mockPort";
import {
  ExportError,
  type ExportCapabilities,
  type ExportPort,
  type ExportResult,
} from "./types";

// The port contract lives in types.ts with the rest of the export model.
export type { ExportPort } from "./types";

/**
 * Explicit-failure port for environments without an export bridge —
 * currently every real Tauri runtime (see the gate note above). Each method
 * rejects/returns honestly so the dialog degrades to a recoverable state.
 */
export class UnsupportedExportPort implements ExportPort {
  capabilities(): Promise<ExportCapabilities> {
    return Promise.reject(
      new ExportError(
        "ENGINE_UNAVAILABLE",
        "export backend is not wired into the Tauri shell yet " +
          "(requires the engine spawn bridge; see src/export/port.ts)",
      ),
    );
  }
  chooseDestination(): Promise<string | null> {
    return Promise.reject(
      new ExportError(
        "ENGINE_UNAVAILABLE",
        "destination picker requires a shell bridge",
      ),
    );
  }
  defaultDestination(): Promise<string> {
    return Promise.reject(
      new ExportError("ENGINE_UNAVAILABLE", "no export backend"),
    );
  }
  export(): Promise<ExportResult> {
    return Promise.reject(
      new ExportError("ENGINE_UNAVAILABLE", "no export backend"),
    );
  }
  revealInExplorer(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export function createDefaultExportPort(): ExportPort {
  if (isTauriRuntime()) return new UnsupportedExportPort();
  return MockExportPort.withDevOverrides();
}
