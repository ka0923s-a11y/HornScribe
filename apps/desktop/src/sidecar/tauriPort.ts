/**
 * TauriSidecarPort — the production {@link SidecarPort} for the packaged
 * shell (ENG-002).
 *
 * The Rust `engine` module (src-tauri/src/engine.rs) owns the process:
 * `engine_spawn` launches `python -m hornscribe.worker` (interpreter
 * resolved via HORNSCRIBE_PYTHON -> repo venvs -> PATH) and streams its
 * stdout/stderr/exit over a {@link Channel}. App-defined commands are
 * not capability-gated, so no ACL/plugin grant is needed — the same
 * self-limiting pattern as `read_audio_bytes` (the frontend cannot pick
 * the program; Rust always spawns the fixed worker module).
 *
 * Channel messages (one JSON object each):
 *   {kind:"line",   line} -> onLine subscribers
 *   {kind:"stderr", line} -> onStderr subscribers
 *   {kind:"exit",   code} -> onExit subscribers (fires exactly once)
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { ERR, SidecarError } from "./protocol";
import type { SidecarPort } from "./port";

interface EngineChannelMessage {
  kind: "line" | "stderr" | "exit";
  line?: string;
  code?: number | null;
}

export class TauriSidecarPort implements SidecarPort {
  private readonly lineCbs = new Set<(line: string) => void>();
  private readonly stderrCbs = new Set<(line: string) => void>();
  private readonly exitCbs = new Set<(code: number | null) => void>();
  private exitFired = false;
  private running = false;

  async start(): Promise<void> {
    const channel = new Channel<EngineChannelMessage>((msg) => {
      switch (msg.kind) {
        case "line":
          if (typeof msg.line === "string") {
            for (const cb of [...this.lineCbs]) cb(msg.line);
          }
          break;
        case "stderr":
          if (typeof msg.line === "string") {
            for (const cb of [...this.stderrCbs]) cb(msg.line);
          }
          break;
        case "exit":
          this.fireExit(msg.code ?? null);
          break;
      }
    });
    try {
      await invoke("engine_spawn", { channel });
    } catch (e) {
      // Spawn failure (no Python, ENGINE_ALREADY_RUNNING) is surfaced
      // as ENGINE_UNAVAILABLE so the session maps it to the
      // worker-not-responding recovery surface — never a silent mock.
      throw new SidecarError(
        ERR.ENGINE_UNAVAILABLE,
        e instanceof Error ? e.message : String(e),
      );
    }
    this.running = true;
  }

  writeLine(line: string): void {
    if (!this.running) {
      throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "engine is not running");
    }
    // invoke is async but fire-and-forget here: write ordering is
    // preserved because Tauri serializes each invoke on the same IPC
    // queue, and a dead worker surfaces via the exit message anyway.
    void invoke("engine_write", { line }).catch(() => {
      /* a write into a dead pipe is reported by the exit event */
    });
  }

  closeStdin(): void {
    if (!this.running) return;
    void invoke("engine_close_stdin").catch(() => undefined);
  }

  kill(): void {
    if (!this.running) return;
    void invoke("engine_kill").catch(() => undefined);
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }
  onStderr(cb: (line: string) => void): () => void {
    this.stderrCbs.add(cb);
    return () => this.stderrCbs.delete(cb);
  }
  onExit(cb: (code: number | null) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  private fireExit(code: number | null): void {
    if (this.exitFired) return; // contract: fires exactly once
    this.exitFired = true;
    this.running = false;
    for (const cb of [...this.exitCbs]) cb(code);
  }
}
