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
 * ## Packaged-app gate (UI-040)
 *
 * A real worker is spawned by the Tauri shell. This branch deliberately
 * does NOT widen `src-tauri/capabilities/default.json`: it grants no
 * shell/process plugin today and no `tauri-plugin-*` dependency exists in
 * `src-tauri/Cargo.toml`. The intended production port is a small Rust
 * supervisor that spawns `python -m hornscribe.worker` (or the frozen
 * engine executable), pipes stdin/stdout, and forwards lines to the
 * frontend — reachable either through `tauri-plugin-shell`'s `Command`
 * events or an app-defined `invoke` + `Channel` (app commands are not
 * capability-gated). Until that lands, `createDefaultSidecarPort()` returns
 * {@link UnsupportedSidecarPort} inside the Tauri webview so the failure is
 * explicit and recoverable, never a silent mock.
 */

import { ERR, SidecarError } from "./protocol";
import { MockSidecarPort } from "./mockPort";
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
 * Placeholder port for environments where no spawn bridge exists yet —
 * currently every real Tauri runtime (see the gate note above). `start()`
 * fails explicitly with ENGINE_UNAVAILABLE; the session maps that to the
 * worker-not-responding recovery surface, so the packaged shell degrades
 * honestly instead of pretending a mock engine is real.
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
 * - inside the Tauri webview: {@link UnsupportedSidecarPort} (gated — see
 *   the note at the top of this file);
 * - in a plain browser (`vite dev`): {@link MockSidecarPort}, an
 *   in-process emulation of `python -m hornscribe.worker` that speaks the
 *   real NDJSON contract so the whole transcription UX is exercisable
 *   without a Python runtime.
 */
export function createDefaultSidecarPort(): SidecarPort {
  if (isTauriRuntime()) return new UnsupportedSidecarPort();
  return new MockSidecarPort();
}
