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
 * ## Runtime gate
 *
 * `createDefaultExportPort()` returns:
 *
 * - {@link MockExportPort} in a plain browser (`vite dev` / vitest) — an
 *   in-process fake that exercises the full §17 flow including
 *   MuseScore-missing and permission-error recovery;
 * - {@link TauriExportPort} inside the Tauri webview (#99) — real
 *   MusicXML/MIDI/PDF export driven by the live score document; the
 *   `source` getter supplies the document + basename at export time.
 */

import { isTauriRuntime } from "../tauri/bridge";
import { MockExportPort } from "./mockPort";
import { TauriExportPort, type ExportSource } from "./tauriPort";
import type { ExportPort } from "./types";

// The port contract lives in types.ts with the rest of the export model.
export type { ExportPort } from "./types";

export function createDefaultExportPort(
  source?: () => ExportSource | null,
  midiExporter?: (scoreDocument: unknown) => Promise<string>,
  /** #390: engine-liveness probe for the canonical-MIDI tier —
   *  false means the exporter RPC would hit a dead worker. */
  engineReady?: () => boolean,
): ExportPort {
  if (isTauriRuntime())
    return new TauriExportPort(
      source ?? (() => null),
      midiExporter,
      engineReady,
    );
  return MockExportPort.withDevOverrides();
}
