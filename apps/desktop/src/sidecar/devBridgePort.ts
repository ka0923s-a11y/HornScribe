/**
 * DevBridgeSidecarPort — the browser-dev {@link SidecarPort} (#86).
 *
 * Inside the Tauri webview the worker is spawned by Rust (engine.rs). In a
 * plain browser there is no process API, so `vite dev` used to fall back to
 * MockSidecarPort and `kind:"file"` audio could never reach the real
 * engine. The devEngineBridge Vite middleware (scripts/devEngineBridge.mjs)
 * exposes the same lifecycle over localhost HTTP + SSE on the dev origin,
 * so this port mirrors {@link TauriSidecarPort} one-for-one:
 *
 *   start()      -> GET /__engine/health (probe) then POST /__engine/spawn
 *   writeLine()  -> POST /__engine/write {line}
 *   closeStdin() -> POST /__engine/stdin-close
 *   kill()       -> POST /__engine/kill
 *   events       -> GET /__engine/events SSE {kind:line|stderr|exit}
 *
 * When the bridge is unreachable (production build opened in a browser,
 * or a dev server without the plugin) start() falls back to an in-process
 * {@link MockSidecarPort} and relays its events — dev sessions keep
 * working exactly as before instead of dead-ending on ENGINE_UNAVAILABLE.
 */

import { ERR, SidecarError } from "./protocol";
import { MockSidecarPort } from "./mockPort";
import type { SidecarPort } from "./port";

const HEALTH_TIMEOUT_MS = 1500;

interface DevBridgeEvent {
  kind: "line" | "stderr" | "exit";
  line?: string;
  code?: number | null;
}

export class DevBridgeSidecarPort implements SidecarPort {
  private readonly lineCbs = new Set<(line: string) => void>();
  private readonly stderrCbs = new Set<(line: string) => void>();
  private readonly exitCbs = new Set<(code: number | null) => void>();
  private fallback: MockSidecarPort | null = null;
  private events: EventSource | null = null;
  private exitFired = false;
  private running = false;

  async start(): Promise<void> {
    if (!(await this.bridgeUp())) {
      // No bridge (e.g. `vite preview` in a browser): behave exactly like
      // the old default — a mock engine that still exercises the UX.
      const mock = new MockSidecarPort();
      this.fallback = mock;
      mock.onLine((l) => {
        for (const cb of [...this.lineCbs]) cb(l);
      });
      mock.onStderr((l) => {
        for (const cb of [...this.stderrCbs]) cb(l);
      });
      mock.onExit((c) => this.fireExit(c));
      await mock.start();
      this.running = true;
      return;
    }

    // Subscribe to the SSE stream before spawning so no early worker
    // output (handshake line) can be lost between the two requests.
    const events = new EventSource("/__engine/events");
    this.events = events;
    events.onmessage = (ev) => {
      let msg: DevBridgeEvent;
      try {
        msg = JSON.parse(ev.data) as DevBridgeEvent;
      } catch {
        return;
      }
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
    };

    try {
      const res = await fetch("/__engine/spawn", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `spawn failed (${res.status})`);
      }
    } catch (e) {
      events.close();
      this.events = null;
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
    if (this.fallback) {
      this.fallback.writeLine(line);
      return;
    }
    void fetch("/__engine/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line }),
    }).catch(() => {
      /* a write into a dead worker is reported by the exit event */
    });
  }

  closeStdin(): void {
    if (!this.running) return;
    if (this.fallback) {
      this.fallback.closeStdin();
      return;
    }
    void fetch("/__engine/stdin-close", { method: "POST" }).catch(
      () => undefined,
    );
  }

  kill(): void {
    if (!this.running) return;
    if (this.fallback) {
      this.fallback.kill();
      return;
    }
    void fetch("/__engine/kill", { method: "POST" }).catch(() => undefined);
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

  private async bridgeUp(): Promise<boolean> {
    try {
      const res = await fetch("/__engine/health", {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; python?: unknown };
      // ok without a resolvable Python is still "up" — spawn will report
      // the honest error, which beats silently mocking a real engine.
      return body.ok === true;
    } catch {
      return false;
    }
  }

  private fireExit(code: number | null): void {
    if (this.exitFired) return; // contract: fires exactly once
    this.exitFired = true;
    this.running = false;
    this.events?.close();
    this.events = null;
    for (const cb of [...this.exitCbs]) cb(code);
  }
}
