/**
 * MockSidecarPort — an in-process emulation of `python -m hornscribe.worker`
 * for browser/dev mode and vitest.
 *
 * It implements the *real* wire contract (protocol/PROTOCOL.md), not a
 * friendly shortcut:
 *
 * - strict inbound validation with MALFORMED_MESSAGE replies (id recovered
 *   when possible, `id: null` otherwise) — same shape as protocol.py;
 * - handshake advertises capabilities; a protocol-version mismatch is
 *   refused with PROTOCOL_VERSION_MISMATCH and the mock exits 0 — refusal,
 *   not a crash, exactly like worker.py;
 * - `demoLongTask` mirrors jobs.py: cancel checkpoints between steps,
 *   deadlineMs → JOB_TIMEOUT, failAtStep → JOB_FAILED, terminal events
 *   exactly once;
 * - `transcription` is the UI-040 stand-in for the real transcription job
 *   kind (not yet in the spike worker): same step engine plus the [UI-040]
 *   `stage` field and a `result.reviewIssues` payload on completion, so
 *   the shell exercises the actual presentation path it will use with the
 *   real backend;
 * - `closeStdin()` = stdin EOF → cooperative cancel of any active job,
 *   then exit 0 (worker.py contract);
 * - `simulateCrash()` dies mid-job WITHOUT a terminal event — the
 *   supervisor must notice the exit itself (ADR-0002);
 * - `simulateHang()` wedges the dispatch loop (like `debug.hang`) so the
 *   client watchdog path can be exercised.
 *
 * Nothing here ships user-visible behavior in the packaged app — the port
 * factory only selects the mock outside the Tauri webview.
 */

import {
  ERR,
  PROTOCOL_VERSION,
  encodeFrame,
  type Envelope,
} from "./protocol";
import { TRANSCRIPTION_STAGE_IDS } from "./jobView";
import type { SidecarPort } from "./port";

const MOCK_METHODS = [
  "engine.handshake",
  "engine.ping",
  "engine.shutdown",
  "job.start",
  "job.cancel",
  "project.open",
];

/** Job kinds this emulation advertises in the handshake. `transcription`
 *  models the future real job kind; `demoLongTask` mirrors the spike
 *  worker so `capabilities.jobKinds` fallback logic is exercised. */
const MOCK_JOB_KINDS = ["transcription", "demoLongTask"];

interface MockJobParams {
  steps: number;
  stepDurationMs: number;
  deadlineMs?: number;
  failAtStep?: number;
}

interface MockJob {
  jobId: string;
  jobKind: string;
  params: MockJobParams;
  step: number;
  cancelled: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
}

export interface MockSidecarOptions {
  /** Simulated worker pid reported by engine.ping / handshake. */
  pid?: number;
  /** Advertised job kinds — defaults to the full mock set; pass
   *  ["demoLongTask"] to emulate the UI-002 spike worker exactly. */
  jobKinds?: readonly string[];
}

export class MockSidecarPort implements SidecarPort {
  private readonly pid: number;
  private readonly jobKinds: readonly string[];
  private lineCbs = new Set<(line: string) => void>();
  private stderrCbs = new Set<(line: string) => void>();
  private exitCbs = new Set<(code: number | null) => void>();
  private alive = false;
  private wedged = false;
  private exited = false;
  private jobCounter = 0;
  private job: MockJob | null = null;
  private startedAt = 0;

  constructor(opts: MockSidecarOptions = {}) {
    this.pid = opts.pid ?? 4242;
    this.jobKinds = opts.jobKinds ?? MOCK_JOB_KINDS;
  }

  // ---- lifecycle ------------------------------------------------------

  async start(): Promise<void> {
    this.alive = true;
    this.exited = false;
    this.startedAt = Date.now();
    // stderr mirrors the real worker's lifecycle logs.
    this.stderr(
      `INFO hornscribe.worker: sidecar started pid=${this.pid} ` +
        `protocol=v${PROTOCOL_VERSION} hornscribe=0.1.0 (mock)`,
    );
  }

  closeStdin(): void {
    // stdin EOF → implicit graceful shutdown: cancel the active job
    // cooperatively (its terminal event still goes out), then exit 0.
    // A wedged dispatch loop never reads stdin — the EOF goes
    // unnoticed, exactly like the real worker's debug.hang (#233).
    if (!this.alive || this.wedged) return;
    const job = this.job;
    if (job && !job.done) {
      job.cancelled = true;
      this.finishJobNow(job);
    }
    this.exit(0);
  }

  kill(): void {
    this.simulateCrash();
  }

  /** Non-zero exit without a terminal job event — a real crash. */
  simulateCrash(code: number | null = 1): void {
    if (!this.alive) return;
    const job = this.job;
    if (job?.timer) clearTimeout(job.timer);
    // The job vanishes mid-flight with NO terminal event — the client
    // must mark it failed itself (ADR-0002 supervision contract).
    this.job = null;
    this.exit(code);
  }

  /** Wedge the dispatch loop: inbound frames are ignored, no frames out. */
  simulateHang(): void {
    this.wedged = true;
    const job = this.job;
    if (job?.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  /** #233: model blocking ML inference — the dispatch loop still
   *  answers requests (job.cancel gets its ack), but the job thread is
   *  inside a non-interruptible call and never reaches the cancel
   *  checkpoint, so no terminal event ever arrives. */
  simulateBlockingInference(): void {
    const job = this.job;
    if (job?.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  /** Test/dev hook: recover a wedged loop (not used in production). */
  unhang(): void {
    this.wedged = false;
    const job = this.job;
    if (job && !job.done && job.timer === null) {
      job.timer = setTimeout(() => this.runStep(job), job.params.stepDurationMs);
    }
  }

  private exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    this.stderr("INFO hornscribe.worker: sidecar stopped (mock)");
    const cbs = [...this.exitCbs];
    for (const cb of cbs) cb(code);
    this.lineCbs.clear();
    this.stderrCbs.clear();
    this.exitCbs.clear();
  }

  // ---- subscriptions ----------------------------------------------------

  writeLine(line: string): void {
    if (!this.alive || this.wedged || this.exited) return;
    this.handleLine(line);
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

  // ---- frame IO ---------------------------------------------------------

  private emit(frame: Envelope): void {
    const line = encodeFrame(frame);
    for (const cb of [...this.lineCbs]) cb(line);
  }

  private stderr(line: string): void {
    for (const cb of [...this.stderrCbs]) cb(line);
  }

  private respond(id: string, method: string, payload: unknown): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id,
      kind: "response",
      method,
      payload,
      error: null,
    });
  }

  private respondError(
    id: string | null,
    method: string | null,
    code: string,
    message: string,
    details?: unknown,
  ): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id,
      kind: "response",
      method,
      payload: null,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    });
  }

  private emitEvent(method: string, payload: Record<string, unknown>): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id: null,
      kind: "event",
      method,
      payload,
      error: null,
    });
  }

  // ---- dispatch (mirrors worker.py `_handle_line`) -----------------------

  private handleLine(line: string): void {
    const text = line.trim();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.respondError(null, null, ERR.MALFORMED_MESSAGE, "frame is not valid JSON");
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.respondError(null, null, ERR.MALFORMED_MESSAGE, "envelope must be a JSON object");
      return;
    }
    const frame = raw as Record<string, unknown>;
    const recoverId =
      typeof frame.id === "string" && frame.id ? frame.id : null;
    // Mirror protocol.py ordering: a non-integer/missing `v` is
    // MALFORMED_MESSAGE; only an integer-but-unsupported `v` is
    // PROTOCOL_VERSION_MISMATCH.
    if (typeof frame.v !== "number" || !Number.isInteger(frame.v)) {
      this.respondError(
        recoverId,
        null,
        ERR.MALFORMED_MESSAGE,
        "'v' must be an integer protocol version",
      );
      return;
    }
    if (frame.v !== PROTOCOL_VERSION) {
      this.respondError(
        recoverId,
        null,
        ERR.PROTOCOL_VERSION_MISMATCH,
        `unsupported protocol version ${String(frame.v)}; worker speaks v${PROTOCOL_VERSION}`,
        { expected: PROTOCOL_VERSION, got: frame.v },
      );
      return;
    }
    if (frame.kind !== "request") {
      // Inbound response/event frames are logged and dropped — never
      // answered — so a reply loop is impossible.
      this.stderr(
        `WARNING hornscribe.worker: ignoring inbound ${String(frame.kind)} frame`,
      );
      return;
    }
    const id = recoverId;
    if (!id) {
      this.respondError(null, null, ERR.MALFORMED_MESSAGE, "request requires a non-empty string 'id'");
      return;
    }
    const method = frame.method;
    if (typeof method !== "string" || !method) {
      this.respondError(id, null, ERR.MALFORMED_MESSAGE, "request requires a non-empty string 'method'");
      return;
    }
    switch (method) {
      case "engine.handshake":
        return this.handleHandshake(id, frame.payload);
      case "engine.ping":
        return this.handlePing(id, frame.payload);
      case "engine.shutdown":
        return this.handleShutdown(id);
      case "job.start":
        return this.handleJobStart(id, frame.payload);
      case "job.cancel":
        return this.handleJobCancel(id, frame.payload);
      case "project.open":
        return this.handleProjectOpen(id, frame.payload);
      default:
        this.respondError(id, method, ERR.UNKNOWN_METHOD, `unknown method '${method}'`, {
          methods: MOCK_METHODS,
        });
    }
  }

  // ---- methods ------------------------------------------------------------

  private handleHandshake(id: string, payload: unknown): void {
    const params =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const clientV = params.protocolVersion ?? PROTOCOL_VERSION;
    if (clientV !== PROTOCOL_VERSION) {
      // Refuse explicitly, then exit 0 — a worker must not serve a peer
      // it cannot talk to (worker.py contract).
      this.respondError(
        id,
        "engine.handshake",
        ERR.PROTOCOL_VERSION_MISMATCH,
        `client requested protocol v${String(clientV)}; worker speaks v${PROTOCOL_VERSION}`,
        { requested: clientV, supported: [PROTOCOL_VERSION] },
      );
      this.exit(0);
      return;
    }
    this.respond(id, "engine.handshake", {
      protocolVersion: PROTOCOL_VERSION,
      engineInfo: {
        name: "hornscribe-engine",
        version: "0.1.0",
        python: "0.0.0-mock",
        platform: "browser",
        pid: this.pid,
      },
      capabilities: {
        methods: MOCK_METHODS,
        jobKinds: [...this.jobKinds],
        maxConcurrentJobs: 1,
        cooperativeCancel: true,
        cancellationFallback: "terminate+restart",
        progressEvents: true,
        basicPitchAvailable: false,
      },
    });
  }

  private handlePing(id: string, payload: unknown): void {
    const echo =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).echo
        : undefined;
    this.respond(id, "engine.ping", {
      echo,
      workerPid: this.pid,
      uptimeMs: Date.now() - this.startedAt,
    });
  }

  private handleShutdown(id: string): void {
    const active = this.job && !this.job.done ? this.job : null;
    this.respond(id, "engine.shutdown", {
      ok: true,
      activeJob: active ? active.jobId : null,
    });
    if (active) {
      active.cancelled = true;
      this.finishJobNow(active);
    }
    this.exit(0);
  }

  private handleJobStart(id: string, payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      this.respondError(id, "job.start", ERR.INVALID_PARAMS, "job.start payload must be an object");
      return;
    }
    const p = payload as Record<string, unknown>;
    const jobKind = p.jobKind;
    if (typeof jobKind !== "string" || !jobKind) {
      this.respondError(id, "job.start", ERR.INVALID_PARAMS, "job.start requires a string 'jobKind'");
      return;
    }
    if (!this.jobKinds.includes(jobKind)) {
      this.respondError(id, "job.start", ERR.UNKNOWN_JOB_KIND, `unsupported jobKind '${jobKind}'`, {
        supported: [...this.jobKinds],
      });
      return;
    }
    if (this.job && !this.job.done) {
      this.respondError(id, "job.start", ERR.JOB_ALREADY_RUNNING, "a job is already running", {
        activeJobId: this.job.jobId,
        maxConcurrentJobs: 1,
      });
      return;
    }
    let params: MockJobParams;
    try {
      params = parseJobParams(p.params);
    } catch (e) {
      this.respondError(id, "job.start", ERR.INVALID_PARAMS, (e as Error).message);
      return;
    }
    this.jobCounter += 1;
    const jobId = `job-${String(this.jobCounter).padStart(4, "0")}`;
    const job: MockJob = {
      jobId,
      jobKind,
      params,
      step: 0,
      cancelled: false,
      done: false,
      timer: null,
      startedAt: Date.now(),
    };
    this.job = job;
    this.respond(id, "job.start", { jobId, jobKind, state: "accepted" });
    this.emitJobEvent(job, "started", {
      step: 0,
      progress: 0,
      totalSteps: params.steps,
      stage: stageFor(job, 0),
    });
    job.timer = setTimeout(() => this.runStep(job), params.stepDurationMs);
  }

  private handleJobCancel(id: string, payload: unknown): void {
    const jobId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).jobId
        : undefined;
    if (typeof jobId !== "string" || !jobId) {
      this.respondError(id, "job.cancel", ERR.INVALID_PARAMS, "job.cancel requires a string 'jobId'");
      return;
    }
    const job = this.job;
    if (!job || job.done || job.jobId !== jobId) {
      this.respondError(id, "job.cancel", ERR.JOB_NOT_FOUND, `no active job '${jobId}'`);
      return;
    }
    job.cancelled = true;
    this.respond(id, "job.cancel", { jobId: job.jobId, cancellation: "requested" });
  }

  /** #365 `project.open` — dev-fake emulation: decodes documentBase64,
   *  JSON.parses and applies the light local checks (the real worker's
   *  migrate+validate lives in Python — this exercises the wire shape
   *  for browser-dev project opens). `path` mode needs real fs access,
   *  which the mock honestly lacks. */
  private handleProjectOpen(id: string, payload: unknown): void {
    const params =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    if (typeof params.path === "string" && params.path) {
      this.respondError(
        id,
        "project.open",
        ERR.INVALID_PARAMS,
        "project.open by path requires the real worker (mock has no fs)",
      );
      return;
    }
    const b64 = params.documentBase64;
    if (typeof b64 !== "string" || !b64) {
      this.respondError(
        id,
        "project.open",
        ERR.INVALID_PARAMS,
        "project.open requires 'path' or 'documentBase64'",
      );
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(atob(b64)) as unknown;
    } catch {
      this.respondError(
        id,
        "project.open",
        ERR.INVALID_PARAMS,
        "project document is not valid JSON/base64",
      );
      return;
    }
    const data = doc as Record<string, unknown> | null;
    if (
      typeof data !== "object" ||
      data === null ||
      data.schemaVersion !== 1 ||
      typeof data.projectId !== "string" ||
      !data.projectId
    ) {
      this.respondError(
        id,
        "project.open",
        ERR.INVALID_PARAMS,
        "invalid or unsupported project document (mock)",
      );
      return;
    }
    this.respond(id, "project.open", { path: "", project: data });
  }

  // ---- job runner (mirrors run_demo_long_task) ----------------------------

  private runStep(job: MockJob): void {
    if (!this.alive || this.wedged || job.done) return;
    const next = job.step + 1;
    // Cooperative cancel: checked between steps, exactly like jobs.py.
    if (job.cancelled) {
      return this.finishJobNow(job);
    }
    if (
      job.params.deadlineMs !== undefined &&
      Date.now() - job.startedAt > job.params.deadlineMs
    ) {
      job.done = true;
      this.emitJobEvent(job, "failed", {
        step: job.step,
        progress: job.step / job.params.steps,
        error: {
          code: ERR.JOB_TIMEOUT,
          message: `job exceeded deadlineMs=${job.params.deadlineMs}`,
        },
      });
      return;
    }
    if (job.params.failAtStep === next) {
      job.step = next;
      job.done = true;
      this.emitJobEvent(job, "failed", {
        step: next,
        progress: (next - 1) / job.params.steps,
        error: {
          code: ERR.JOB_FAILED,
          message: `${job.jobKind} failed at step ${next} (failAtStep hook)`,
        },
      });
      return;
    }
    job.step = next;
    this.emitJobEvent(job, "progress", {
      step: next,
      progress: next / job.params.steps,
      totalSteps: job.params.steps,
      stage: stageFor(job, next),
    });
    if (next >= job.params.steps) {
      job.done = true;
      this.emitJobEvent(job, "completed", {
        step: next,
        progress: 1,
        elapsedMs: Date.now() - job.startedAt,
        result: job.jobKind === "transcription" ? transcriptionResult() : { steps: job.params.steps },
      });
      return;
    }
    job.timer = setTimeout(() => this.runStep(job), job.params.stepDurationMs);
  }

  /** Emit the terminal `cancelled` event now (shutdown path or cancel
   *  observed at a step boundary). */
  private finishJobNow(job: MockJob): void {
    if (job.done) return;
    if (job.timer) clearTimeout(job.timer);
    job.done = true;
    this.emitJobEvent(job, "cancelled", {
      step: job.step,
      progress: job.step / job.params.steps,
      reason: "cancel requested between steps",
    });
  }

  private emitJobEvent(
    job: MockJob,
    phase: string,
    fields: Record<string, unknown>,
  ): void {
    const body: Record<string, unknown> = {
      jobId: job.jobId,
      jobKind: job.jobKind,
      phase,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    this.emitEvent("job.event", body);
  }
}

// ---- helpers ---------------------------------------------------------------

/** `stage` field reported by stage-aware job kinds (UI-040 contract).
 *  `demoLongTask` reports none — the spike worker doesn't know stages.
 *  Step 0 (`started`) maps onto the first stage; each later step advances
 *  to the next stage, saturating at the last one for longer jobs. */
function stageFor(job: MockJob, step: number): string | undefined {
  if (job.jobKind !== "transcription") return undefined;
  return TRANSCRIPTION_STAGE_IDS[
    Math.min(step, TRANSCRIPTION_STAGE_IDS.length - 1)
  ];
}

function parseJobParams(raw: unknown): MockJobParams {
  if (raw === undefined || raw === null) {
    return { steps: TRANSCRIPTION_STAGE_IDS.length, stepDurationMs: 400 };
  }
  if (typeof raw !== "object") throw new Error("params must be an object");
  const p = raw as Record<string, unknown>;
  const int = (name: string, dflt: number | undefined, lo: number, hi: number) => {
    const v = p[name] ?? dflt;
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`params.${name} must be an integer`);
    }
    if (v < lo || v > hi) throw new Error(`params.${name} out of range [${lo}, ${hi}]`);
    return v;
  };
  const num = (name: string, dflt: number | undefined, lo: number, hi: number) => {
    const v = p[name] ?? dflt;
    if (v === undefined) return undefined;
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new Error(`params.${name} must be a number`);
    }
    if (v < lo || v > hi) throw new Error(`params.${name} out of range [${lo}, ${hi}]`);
    return v;
  };
  return {
    steps: int("steps", TRANSCRIPTION_STAGE_IDS.length, 1, 100000)!,
    stepDurationMs: num("stepDurationMs", 400, 0, 60000)!,
    deadlineMs: num("deadlineMs", undefined, 1, 3600000),
    failAtStep: int("failAtStep", undefined, 1, 100000),
  };
}

/** Sample completed-job result for the `transcription` kind — real
 *  ReviewIssue reason codes from python/hornscribe/domain/review.py so
 *  the UI's reason→copy mapping is exercised with genuine values. */
function transcriptionResult(): Record<string, unknown> {
  return {
    scoreRevision: "sr-mock-0001",
    reviewIssues: [
      {
        id: "ri-000001",
        scoreRevision: "sr-mock-0001",
        canonicalNoteIds: ["sn-000004"],
        timeRange: { startSec: 4.02, endSec: 4.51 },
        reason: "quantization_ambiguous",
        severity: "caution",
        evidence: { modelConfidence: 0.61 },
        status: "open",
      },
      {
        id: "ri-000002",
        scoreRevision: "sr-mock-0001",
        canonicalNoteIds: ["sn-000009"],
        timeRange: { startSec: 9.87, endSec: 10.34 },
        reason: "low_model_confidence",
        severity: "warning",
        evidence: { modelConfidence: 0.44 },
        status: "open",
      },
      {
        id: "ri-000003",
        scoreRevision: "sr-mock-0001",
        canonicalNoteIds: ["sn-000017"],
        timeRange: { startSec: 21.2, endSec: 21.83 },
        reason: "outside_preferred_horn_range",
        severity: "info",
        evidence: {},
        status: "open",
      },
    ],
  };
}
