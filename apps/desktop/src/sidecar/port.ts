/**
 * SidecarPort — the transport seam between the typed NDJSON client and a
 * concrete worker process.
 *
 * The port owns process lifecycle only: it delivers whole stdout lines to
 * the client and accepts whole request lines back. It knows nothing about
 * the protocol (no JSON parsing) — that layering mirrors the UI-002 test
 * harness (`WorkerHandle`), which is why the same client runs against the
 * in-process MockSidecarPort and, later, a Tauri-spawned worker unchanged.
 *
 * ## Packaged-app transport (ENG-002)
 *
 * Inside the Tauri webview the worker is spawned by the shell's own
 * `engine` module (src-tauri/src/engine.rs): `engine_spawn` launches
 * `python -m hornscribe.worker` and relays stdout/stderr/exit over a
 * `Channel` — see {@link TauriSidecarPort}. No plugin capability was
 * widened: app-defined commands are not ACL-gated and the spawned
 * program is fixed Rust-side, so the bridge cannot be turned into a
 * general process launcher. `UnsupportedSidecarPort` remains the
 * explicit-failure placeholder for runtimes with no spawn bridge.
 */

import { ERR, SidecarError } from "./protocol";
import { DevBridgeSidecarPort } from "./devBridgePort";
import { TauriSidecarPort } from "./tauriPort";
import { isTauriRuntime } from "../tauri/bridge";

export interface SidecarPort {
  /**
   * Spawn/attach the worker. Resolves when the process is up and its
   * stdin is writable — the protocol handshake happens after this, on the
   * client. Rejects when the worker cannot be launched at all.
   */
  start(): Promise<void>;
  /** Write one NDJSON frame to the worker's stdin (a newline is appended). */
  writeLine(line: string): void;
  /**
   * Close the worker's stdin — the worker treats EOF as an implicit
   * graceful `engine.shutdown` (worker.py contract).
   */
  closeStdin(): void;
  /**
   * Terminate the worker immediately. This is the documented
   * terminate/restart fallback for non-interruptible jobs and the
   * unresponsive-worker path (ENGINE_RUNTIME_MATRIX / ADR-0002).
   */
  kill(): void;
  /** Subscribe to raw stdout lines. Returns an unsubscribe function. */
  onLine(cb: (line: string) => void): () => void;
  /** Subscribe to stderr lines (diagnostics only, never protocol). */
  onStderr(cb: (line: string) => void): () => void;
  /**
   * Subscribe to process exit. Fires exactly once. `code` is the exit
   * code, or null when it cannot be determined (e.g. killed by signal).
   */
  onExit(cb: (code: number | null) => void): () => void;
}

/**
 * Placeholder port for environments where no spawn bridge exists.
 * `start()` fails explicitly with ENGINE_UNAVAILABLE; the session maps
 * that to the worker-not-responding recovery surface, so the shell
 * degrades honestly instead of pretending a mock engine is real.
 */
export class UnsupportedSidecarPort implements SidecarPort {
  async start(): Promise<void> {
    throw new SidecarError(
      ERR.ENGINE_UNAVAILABLE,
      "engine sidecar spawn is not wired into the Tauri shell yet " +
        "(requires a process bridge; see src/sidecar/README.md)",
    );
  }
  writeLine(): void {
    throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "sidecar port is unavailable");
  }
  closeStdin(): void {
    /* no worker */
  }
  kill(): void {
    /* no worker */
  }
  onLine(): () => void {
    return () => undefined;
  }
  onStderr(): () => void {
    return () => undefined;
  }
  onExit(): () => void {
    return () => undefined;
  }
}

/**
 * The port used when no explicit one is injected:
 * - inside the Tauri webview: {@link TauriSidecarPort} (ENG-002 — the
 *   Rust engine supervisor spawns `python -m hornscribe.worker`);
 * - in a plain browser (`vite dev`): {@link DevBridgeSidecarPort} (#86) —
 *   it spawns the real worker through the devEngineBridge Vite middleware
 *   when the bridge is reachable, and silently degrades to the
 *   in-process MockSidecarPort NDJSON emulation when it is
 *   not, so the transcription UX stays exercisable without Python.
 */
export function createDefaultSidecarPort(): SidecarPort {
  if (isTauriRuntime()) return new TauriSidecarPort();
  return new DevBridgeSidecarPort();
}
