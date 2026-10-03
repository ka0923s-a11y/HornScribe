/**
 * SidecarClient — typed NDJSON protocol client over a {@link SidecarPort}.
 *
 * Implements the shell half of protocol/PROTOCOL.md:
 *
 * - `engine.handshake` on {@link start} (first message after spawn);
 *   a protocol-version mismatch fails explicitly — the worker exits and
 *   the client surfaces the refusal.
 * - request/response correlation by id; events (`job.event`) are demuxed
 *   to subscribers and never disturb pending requests.
 * - per-request timeouts → `SidecarError(REQUEST_TIMEOUT)`.
 * - an in-flight-job watchdog: while any job is active, silence longer
 *   than `watchdogMs` triggers an `engine.ping` probe; a probe timeout
 *   marks the client `unresponsive` (worker.py `debug.hang` proved this
 *   supervision path engine-side).
 * - crash detection: a port exit that was not a requested shutdown marks
 *   the client `crashed`, rejects pending requests with WORKER_CRASHED and
 *   notifies subscribers — the session layer then marks the in-flight job
 *   failed (ADR-0002: never silently resubmitted).
 *
 * Malformed inbound lines are routed to the diagnostics channel and
 * dropped — never answered — mirroring the worker's own containment rule.
 */

import {
  ERR,
  PROTOCOL_VERSION,
  SidecarError,
  encodeFrame,
  isTerminalPhase,
  parseInboundFrame,
  requestFrame,
  type EngineCapabilities,
  type EngineInfo,
  type HandshakeResult,
  type JobCancelResult,
  type JobEventPayload,
  type JobStartResult,
  type PingResult,
  type ProtocolErrorObject,
  type ShutdownResult,
} from "./protocol";
import type { SidecarPort } from "./port";

export type SidecarClientState =
  /** Constructed, not yet started. */
  | "idle"
  /** port.start + handshake in flight. */
  | "starting"
  /** Handshake done — requests may be issued. */
  | "ready"
  /** Graceful shutdown completed (or exit after close). */
  | "closed"
  /** Worker exited without a requested shutdown. */
  | "crashed"
  /** Watchdog probe timed out while a job was in flight. */
  | "unresponsive";

export interface SidecarClientOptions {
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /** job.start timeout — separate because the worker synchronously
   *  warms the engine import stack (librosa/basic_pitch) on the main
   *  thread before answering "accepted" (#155). A frozen-packaged cold
   *  start takes tens of seconds here; the generic 10 s request timeout
   *  made every first transcription fail with a spurious timeout and
   *  dropped the late response as an unknown id. The watchdog cannot
   *  fire while this request pends (the job is not active until the
   *  response resolves), so a long window is safe. */
  jobStartTimeoutMs?: number;
  /** Handshake timeout — interpreter cold start can be slow (UI-002
   *  measured ≈200 ms locally; packaged first-run may be far slower). */
  handshakeTimeoutMs?: number;
  /** Silence tolerated while a job is in flight before probing. */
  watchdogMs?: number;
  /** Probe (`engine.ping`) timeout once the watchdog fires. */
  pingTimeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (payload: unknown) => void;
  reject: (err: SidecarError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULTS: Required<SidecarClientOptions> = {
  requestTimeoutMs: 10_000,
  jobStartTimeoutMs: 120_000,
  /* #184: the frozen engine's onefile self-extract can take 40-60s on a
   * loaded/AV-scanning machine — a 30s cap declared it dead while it
   * was still booting, orphaned a healthy worker, and put the user in a
   * restart loop that repays the same unpack. 120s still fails fast on
   * a real death (the port exit event rejects immediately); the extra
   * wait only binds an alive-but-silent boot, where waiting is right. */
  handshakeTimeoutMs: 120_000,
  watchdogMs: 15_000,
  pingTimeoutMs: 5_000,
};

export class SidecarClient {
  private readonly port: SidecarPort;
  private readonly opts: Required<SidecarClientOptions>;
  private state: SidecarClientState = "idle";
  private counter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly jobEventCbs = new Set<(e: JobEventPayload) => void>();
  private readonly stateCbs = new Set<(s: SidecarClientState) => void>();
  private readonly diagCbs = new Set<(line: string) => void>();
  private readonly activeJobs = new Set<string>();
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private probing = false;
  private shutdownRequested = false;
  private handshakeResult: HandshakeResult | null = null;

  constructor(port: SidecarPort, opts: SidecarClientOptions = {}) {
    this.port = port;
    this.opts = { ...DEFAULTS, ...opts };
    port.onLine((line) => this.handleLine(line));
    port.onStderr((line) => this.diagnose(`stderr: ${line}`));
    port.onExit((code) => this.handleExit(code));
  }

  // ---- surface ---------------------------------------------------------

  getState(): SidecarClientState {
    return this.state;
  }

  get engineInfo(): EngineInfo | null {
    return this.handshakeResult?.engineInfo ?? null;
  }

  get capabilities(): EngineCapabilities | null {
    return this.handshakeResult?.capabilities ?? null;
  }

  get handshake(): HandshakeResult | null {
    return this.handshakeResult;
  }

  /** Ids of jobs started via this client that have not reached a
   *  terminal event (used by the session for crash bookkeeping). */
  get inFlightJobs(): readonly string[] {
    return [...this.activeJobs];
  }

  onJobEvent(cb: (e: JobEventPayload) => void): () => void {
    this.jobEventCbs.add(cb);
    return () => this.jobEventCbs.delete(cb);
  }

  onStateChange(cb: (s: SidecarClientState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  /** Diagnostics channel: malformed inbound frames, stderr lines,
   *  supervision notes. Never user-facing copy. */
  onDiagnostic(cb: (line: string) => void): () => void {
    this.diagCbs.add(cb);
    return () => this.diagCbs.delete(cb);
  }

  private setState(s: SidecarClientState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of [...this.stateCbs]) cb(s);
  }

  private diagnose(line: string): void {
    for (const cb of [...this.diagCbs]) cb(line);
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Spawn the worker and run `engine.handshake`. Resolves with the
   * handshake result once the engine is `ready`. Rejects on spawn failure,
   * timeout, or a PROTOCOL_VERSION_MISMATCH refusal (the worker then exits
   * and `crashed` is signalled via the exit path).
   */
  async start(): Promise<HandshakeResult> {
    if (this.state !== "idle") {
      throw new SidecarError(
        ERR.ENGINE_NOT_READY,
        `client.start() from state '${this.state}'`,
      );
    }
    this.setState("starting");
    try {
      await this.port.start();
    } catch (e) {
      this.setState("crashed");
      throw e instanceof SidecarError
        ? e
        : new SidecarError(ERR.ENGINE_UNAVAILABLE, String(e));
    }
    let result: HandshakeResult;
    /* #184: slow cold starts are silent — heartbeat into diagnostics so
     * the drawer can tell "still booting" from "dead". */
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      this.diagnose(
        `engine.handshake pending ${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s — cold start in progress`,
      );
    }, 15_000);
    try {
      result = (await this.requestRaw(
        "engine.handshake",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "hornscribe-desktop", surface: "react" },
        },
        this.opts.handshakeTimeoutMs,
        /* allowBeforeReady */ true,
      )) as HandshakeResult;
    } catch (e) {
      clearInterval(heartbeat);
      // Timeout / refusal / dead port — never leave the client wedged in
      // "starting"; the exit event may also mark it crashed, both are dead.
      if (this.getState() === "starting") this.setState("crashed");
      throw e;
    }
    clearInterval(heartbeat);
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      this.setState("crashed");
      throw new SidecarError(
        ERR.PROTOCOL_VERSION_MISMATCH,
        `worker reported protocolVersion ${String(result.protocolVersion)}`,
      );
    }
    this.handshakeResult = result;
    this.setState("ready");
    return result;
  }

  /** Graceful shutdown: `engine.shutdown`, then stdin EOF fallback, and
   *  finally a bounded wait for the exit event. Never throws. */
  async shutdown(timeoutMs = 3_000): Promise<void> {
    if (this.state === "closed" || this.state === "crashed") {
      this.setState("closed");
      return;
    }
    this.shutdownRequested = true;
    try {
      if (this.state === "ready") {
        await this.requestRaw<ShutdownResult>(
          "engine.shutdown",
          {},
          Math.min(timeoutMs, this.opts.requestTimeoutMs),
          true,
        );
      }
    } catch {
      // The worker may already be gone — stdin EOF below is the fallback.
    }
    try {
      this.port.closeStdin();
    } catch {
      /* port already dead */
    }
    // Bounded wait for the exit event; then mark closed regardless —
    // shutdown must not hang the UI.
    const deadline = Date.now() + timeoutMs;
    while (
      this.getState() !== "closed" &&
      this.getState() !== "crashed" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }
    // #233: a wedged dispatch loop sees neither the shutdown request nor
    // the stdin EOF — kill the process so the supervisor slot is freed.
    // Without this a respawn races the zombie and hits
    // ENGINE_ALREADY_RUNNING.
    if (this.getState() !== "closed" && this.getState() !== "crashed") {
      this.diagnose("graceful shutdown timed out — killing worker");
      try {
        this.port.kill();
      } catch {
        /* port already dead */
      }
      const killDeadline = Date.now() + 1_000;
      while (
        this.getState() !== "closed" &&
        this.getState() !== "crashed" &&
        Date.now() < killDeadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    this.clearWatchdog();
    this.rejectAllPending(new SidecarError(ERR.ENGINE_NOT_READY, "client shut down"));
    this.setState("closed");
  }

  /** Immediate terminate — skips the graceful request entirely (the
   *  cancel-escalation path: the worker is mid-inference and cannot
   *  answer anyway). Waits briefly for the exit event so a respawn does
   *  not race the dying process. */
  async terminate(): Promise<void> {
    if (this.state === "closed" || this.state === "crashed") return;
    this.shutdownRequested = true;
    this.clearWatchdog();
    try {
      this.port.kill();
    } catch {
      /* port already dead */
    }
    const deadline = Date.now() + 1_000;
    while (
      this.getState() !== "closed" &&
      this.getState() !== "crashed" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    this.rejectAllPending(
      new SidecarError(ERR.ENGINE_NOT_READY, "worker terminated"),
    );
    this.setState("closed");
  }

  /** Liveness + latency probe. */
  async ping(echo: unknown = null): Promise<PingResult> {
    return this.request<PingResult>("engine.ping", { echo });
  }

  /** `job.start` — returns {jobId, jobKind, state:"accepted"}.
   *  JOB_ALREADY_RUNNING is enforced engine-side. */
  async startJob(jobKind: string, params: unknown): Promise<JobStartResult> {
    const res = await this.requestRaw<JobStartResult>(
      "job.start",
      { jobKind, params },
      this.opts.jobStartTimeoutMs,
      false,
    );
    this.activeJobs.add(res.jobId);
    this.armWatchdog();
    return res;
  }

  /** `job.cancel` — cooperative: the job emits its terminal `cancelled`
   *  event at the next checkpoint. JOB_NOT_FOUND means it already ended. */
  async cancelJob(jobId: string): Promise<JobCancelResult> {
    return this.request<JobCancelResult>("job.cancel", { jobId });
  }

  /** Generic engine method call (#100: `project.save` and future
   *  non-job methods). Same correlation/timeout discipline as the
   *  job verbs; requires the client to be `ready`. */
  async call<T>(method: string, payload: unknown): Promise<T> {
    return this.request<T>(method, payload);
  }

  // ---- requests -----------------------------------------------------------

  private async request<T>(method: string, payload: unknown): Promise<T> {
    return this.requestRaw<T>(method, payload, this.opts.requestTimeoutMs, false);
  }

  private requestRaw<T>(
    method: string,
    payload: unknown,
    timeoutMs: number,
    allowBeforeReady: boolean,
  ): Promise<T> {
    if (!allowBeforeReady && this.state !== "ready") {
      return Promise.reject(
        new SidecarError(
          ERR.ENGINE_NOT_READY,
          `cannot issue '${method}' while client is '${this.state}'`,
        ),
      );
    }
    this.counter += 1;
    const id = `req-${String(this.counter).padStart(6, "0")}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SidecarError(
            ERR.REQUEST_TIMEOUT,
            `no response to '${method}' within ${timeoutMs}ms`,
            { method, id },
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (p: unknown) => void,
        reject,
        timer,
      });
      try {
        this.port.writeLine(encodeFrame(requestFrame(id, method, payload)));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          e instanceof SidecarError
            ? e
            : new SidecarError(ERR.ENGINE_UNAVAILABLE, String(e)),
        );
      }
    });
  }

  // ---- inbound frames -------------------------------------------------------

  private handleLine(line: string): void {
    this.touch();
    const frame = parseInboundFrame(line);
    if (!frame) {
      this.diagnose(`dropped malformed inbound frame: ${line.slice(0, 200)}`);
      return;
    }
    if (frame.kind === "response") {
      this.handleResponse(frame.id, frame.method, frame.payload, frame.error);
    } else {
      this.handleEvent(frame.method, frame.payload);
    }
  }

  private handleResponse(
    id: string | null,
    method: string | null,
    payload: unknown,
    error: ProtocolErrorObject | null,
  ): void {
    if (id === null) {
      // The one sanctioned null-id response: the worker could not recover
      // an id from a frame it rejected. We never send unrecoverable
      // frames, so this is a diagnostics curiosity, not a request result.
      this.diagnose(
        `null-id error response (${method ?? "?"}): ${error?.code ?? "?"} ${error?.message ?? ""}`,
      );
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.diagnose(`response for unknown id '${id}' dropped`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) {
      pending.reject(new SidecarError(error.code, error.message, error.details));
    } else {
      pending.resolve(payload);
    }
  }

  private handleEvent(method: string | null, payload: unknown): void {
    if (method !== "job.event") {
      this.diagnose(`event '${method ?? "?"}' dropped (no subscriber)`);
      return;
    }
    const body = (payload ?? {}) as JobEventPayload;
    if (typeof body.jobId !== "string" || typeof body.phase !== "string") {
      this.diagnose("job.event without jobId/phase dropped");
      return;
    }
    if (isTerminalPhase(body.phase)) {
      this.activeJobs.delete(body.jobId);
      if (this.activeJobs.size === 0) this.clearWatchdog();
    }
    for (const cb of [...this.jobEventCbs]) cb(body);
  }

  // ---- crash / watchdog ------------------------------------------------------

  private touch(): void {
    if (this.activeJobs.size > 0 && this.state === "ready") this.armWatchdog();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.state !== "ready" || this.activeJobs.size === 0) return;
    this.watchdogTimer = setTimeout(() => void this.probe(), this.opts.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Watchdog probe: the job produced no frames for watchdogMs — ping the
   *  worker; if even that times out, declare it unresponsive. */
  private async probe(): Promise<void> {
    if (this.probing || this.state !== "ready" || this.activeJobs.size === 0) {
      return;
    }
    this.probing = true;
    try {
      await this.requestRaw(
        "engine.ping",
        { echo: "watchdog" },
        this.opts.pingTimeoutMs,
        true,
      );
      // Alive — re-arm. A busy worker answers ping even mid-job (the
      // dispatch loop is independent of the job thread).
      this.armWatchdog();
    } catch {
      this.setState("unresponsive");
      this.clearWatchdog();
      this.diagnose("worker did not answer watchdog ping — unresponsive");
      this.rejectAllPending(
        new SidecarError(ERR.WORKER_UNRESPONSIVE, "worker is not responding"),
      );
    } finally {
      this.probing = false;
    }
  }

  private handleExit(code: number | null): void {
    this.clearWatchdog();
    const graceful = this.shutdownRequested || code === 0;
    this.rejectAllPending(
      new SidecarError(
        graceful ? ERR.ENGINE_NOT_READY : ERR.WORKER_CRASHED,
        graceful ? "worker shut down" : `worker exited (code ${String(code)})`,
      ),
    );
    this.setState(graceful ? "closed" : "crashed");
    if (!graceful) {
      this.diagnose(`worker exited unexpectedly (code ${String(code)})`);
    }
  }

  private rejectAllPending(err: SidecarError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
