/**
 * TranscriptionSession — the app-facing engine/job state machine
 * (GUI_UX_SPEC §5, §27; ADR-0002 failure model).
 *
 * One job at a time (the worker enforces `maxConcurrentJobs: 1`).
 * The session owns a {@link SidecarClient} built on a port factory, so a
 * crashed worker can be replaced by a fresh spawn without restarting the
 * UI — restart is an explicit recovery action, never silent resubmission.
 *
 * State is exposed as an immutable {@link SessionSnapshot} via
 * `subscribe()` — React consumes it through a single `useEffect`, and the
 * §27 screen machine maps it to `transcribing` / `transcriptionError` /
 * `scoreReady` / `audioReady`.
 */

import { SidecarClient, type SidecarClientOptions } from "./client";
import {
  ERR,
  SidecarError,
  type EngineCapabilities,
  type EngineInfo,
  type JobEventPayload,
  type JobStartResult,
} from "./protocol";
import type { SidecarPort } from "./port";
import {
  createJobView,
  markCancelling,
  markJobDead,
  reduceJobEvent,
  type JobView,
} from "./jobView";
import { extractReviewIssueCount } from "./review";

/** Real transcription job kind; the spike worker only knows
 *  `demoLongTask`, so the session falls back to it when `transcription`
 *  is not in `capabilities.jobKinds` — documented as the UI-002→UI-040
 *  bridge until the engine ships the real kind. */
export const TRANSCRIPTION_JOB_KIND = "transcription";
export const FALLBACK_JOB_KIND = "demoLongTask";

export type EngineStatus =
  /** No client yet (never started, or torn down). */
  | "offline"
  /** Spawn + handshake in flight. */
  | "starting"
  /** Handshake done — the engine can accept jobs. */
  | "ready"
  /** Worker exited unexpectedly (crash). Restart is an explicit action. */
  | "crashed"
  /** Watchdog: worker stopped answering mid-job. */
  | "unresponsive"
  /** Graceful shutdown completed. */
  | "closed";

/**
 * The failure classes the §20 error surfaces distinguish:
 * - `transcriptionFailed` — the job ended in a terminal `failed` event
 *   while the engine stayed alive → 再試行 is meaningful.
 * - `workerCrashed` — the process died mid-job → エンジンを再起動.
 * - `workerNotResponding` — watchdog probe timed out → エンジンを再起動.
 */
export type FailureKind =
  | "transcriptionFailed"
  | "workerCrashed"
  | "workerNotResponding";

export interface SessionFailure {
  kind: FailureKind;
  /** Machine-readable detail for the diagnostics surface — codes and
   *  engine messages stay OUT of normal UI copy (JAPANESE_UI_COPY §7). */
  detail: string;
  errorCode?: string;
  /** ENGINE_DEPENDENCY_MISSING only: the missing package name, carried
   *  so the error surface can name what to install (#195). */
  errorPackage?: string;
}

export interface SessionSnapshot {
  engine: EngineStatus;
  engineInfo: EngineInfo | null;
  /** Negotiated protocol version from the last successful handshake
   *  (kept after a crash as last-known, same as engineInfo) — the
   *  diagnostics surface (#403) reports this instead of a constant. */
  protocolVersion: number | null;
  capabilities: EngineCapabilities | null;
  /** In-flight or just-ended job — null when idle. */
  job: JobView | null;
  /** Set on terminal failure; cleared on retry/restart/dismiss. */
  failure: SessionFailure | null;
  /**
   * The `completed` event's `result` payload — the score-data handoff
   * point. UI-030's adapter consumes this to build the canonical score
   * view; UI-040 only guarantees it is preserved verbatim and never
   * mutated by the progress layer.
   */
  lastResult: unknown;
  /** Count of open review issues in `lastResult` (0 when none). */
  reviewIssueCount: number;
  /** Recent supervision diagnostics (stderr + client notes). Ring buffer. */
  diagnostics: readonly string[];
}

type Listener = (snapshot: SessionSnapshot) => void;

export interface TranscriptionSessionOptions {
  portFactory: () => SidecarPort;
  clientOptions?: SidecarClientOptions;
  /** Max retained diagnostic lines. */
  diagnosticLogLimit?: number;
  /** #233: grace between the cooperative job.cancel ack and the
   *  terminate+restart fallback. Blocking inference cannot answer
   *  mid-call, so a terminal event that never arrives within this
   *  window escalates to killing the worker and respawning a fresh
   *  engine. */
  cancelGraceMs?: number;
  /** Wall clock — injectable for tests. */
  now?: () => number;
}

const DEFAULT_DIAGNOSTIC_LIMIT = 80;
const DEFAULT_CANCEL_GRACE_MS = 4_000;

export class TranscriptionSession {
  private readonly portFactory: () => SidecarPort;
  private readonly clientOptions?: SidecarClientOptions;
  private readonly logLimit: number;
  private readonly cancelGraceMs: number;
  private readonly now: () => number;
  private client: SidecarClient | null = null;
  private readonly listeners = new Set<Listener>();
  private snap: SessionSnapshot = {
    engine: "offline",
    engineInfo: null,
    protocolVersion: null,
    capabilities: null,
    job: null,
    failure: null,
    lastResult: null,
    reviewIssueCount: 0,
    diagnostics: [],
  };
  private logLines: string[] = [];

  constructor(opts: TranscriptionSessionOptions) {
    this.portFactory = opts.portFactory;
    this.clientOptions = opts.clientOptions;
    this.logLimit = opts.diagnosticLogLimit ?? DEFAULT_DIAGNOSTIC_LIMIT;
    this.cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- subscription -------------------------------------------------------

  getSnapshot(): SessionSnapshot {
    return this.snap;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const cb of [...this.listeners]) cb(this.snap);
  }

  private log(line: string): void {
    this.logLines = [...this.logLines.slice(-(this.logLimit - 1)), line];
    this.update({ diagnostics: this.logLines });
  }

  // ---- engine lifecycle ------------------------------------------------------

  private buildClient(): SidecarClient {
    const client = new SidecarClient(this.portFactory(), this.clientOptions);
    // #233: only the CURRENT client may move the session — a replaced
    // worker's late exit/state frames must not downgrade the fresh
    // engine or rewrite the settled job view.
    client.onJobEvent((e) => {
      if (this.client === client) this.onJobEvent(e);
    });
    client.onStateChange((s) => {
      if (this.client === client) this.onClientState(s);
    });
    client.onDiagnostic((l) => this.log(l));
    return client;
  }

  /** Lazily spawn + handshake. Idempotent while `ready`. */
  private async ensureEngine(): Promise<void> {
    if (this.client && this.snap.engine === "ready") return;
    this.update({ engine: "starting" });
    const client = this.buildClient();
    this.client = client;
    try {
      const hs = await client.start();
      this.update({
        engine: "ready",
        engineInfo: hs.engineInfo,
        protocolVersion: hs.protocolVersion,
        capabilities: hs.capabilities,
      });
    } catch (e) {
      // Spawn/handshake failure → the engine is down, the error surface
      // offers エンジンを再起動 (which builds a fresh port+client).
      this.update({
        engine: "crashed",
        failure: {
          kind: "workerNotResponding",
          detail: e instanceof Error ? e.message : String(e),
          errorCode: e instanceof SidecarError ? e.code : undefined,
        },
      });
      throw e;
    }
  }

  /**
   * エンジンを再起動 — the crash/unresponsive recovery action (§20).
   * Tears down the old client (best-effort shutdown, then kill) and runs
   * a fresh spawn + handshake. Never resubmits a job.
   */
  async restartEngine(): Promise<void> {
    const old = this.client;
    this.client = null;
    if (old) {
      // #233: await the teardown — shutdown() now kills the worker when
      // the graceful path times out, and the respawn must not race a
      // still-living process (ENGINE_ALREADY_RUNNING).
      await old.shutdown(800).catch(() => undefined);
    }
    this.update({ engine: "starting", failure: null });
    const client = this.buildClient();
    this.client = client;
    try {
      const hs = await client.start();
      this.update({
        engine: "ready",
        engineInfo: hs.engineInfo,
        protocolVersion: hs.protocolVersion,
        capabilities: hs.capabilities,
      });
    } catch (e) {
      this.update({
        engine: "crashed",
        failure: {
          kind: "workerNotResponding",
          detail: e instanceof Error ? e.message : String(e),
          errorCode: e instanceof SidecarError ? e.code : undefined,
        },
      });
      throw e;
    }
  }

  /** Graceful teardown for app shutdown — never throws. */
  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.shutdown();
    this.update({ engine: "closed" });
  }

  /**
   * `project.open` (#365): the authoritative open path — the worker
   * reads (or decodes), migrates and validates the document, and returns
   * the normalized current-schema dict. `path` covers MRU/disk opens;
   * `documentBase64` covers byte-opens (File drops, autosave snapshots).
   * Spawns the engine lazily, same as saveProject.
   */
  async inspectProject(
    ref: { path: string } | { documentBase64: string },
  ): Promise<{
    path: string;
    project: Record<string, unknown>;
    /** #391: set when the response came from the `.recovery` sibling
     *  because the main file was unreadable. */
    recovered?: boolean;
  }> {
    await this.ensureEngine();
    const client = this.client;
    if (!client) {
      throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "no engine client");
    }
    return client.call<{
      path: string;
      project: Record<string, unknown>;
      recovered?: boolean;
    }>(
      "project.open",
      ref,
    );
  }

  /**
   * `score.edit` (#115, spec 13): apply one rhythm edit (setDuration /
   * shiftOnset / toggleTie) against the canonical scoreDocument. Returns
   * the rebuilt payload + fresh concert/horn MusicXML + the new
   * content-derived scoreRevision. The engine worker is the same one
   * that produced the score — the call reuses the live client and only
   * spawns lazily when the engine is down.
   */
  async applyScoreEdit(
    scoreDocument: unknown,
    edit: unknown,
  ): Promise<{
    scoreDocument: unknown;
    scoreRevision: string;
    musicXmlConcert: string;
    musicXmlHornF: string;
  }> {
    await this.ensureEngine();
    const client = this.client;
    if (!client) {
      throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "no engine client");
    }
    return client.call<{
      scoreDocument: unknown;
      scoreRevision: string;
      musicXmlConcert: string;
      musicXmlHornF: string;
    }>("score.edit", { scoreDocument, edit });
  }

  /**
   * `export.midi` (#256): canonical playback MIDI for a scoreDocument —
   * the engine's exporter keeps velocity / pitch bend / swing / tempo
   * map that the client-side MusicXML→MIDI rebuild loses. Spawns the
   * engine lazily like applyScoreEdit.
   */
  async exportMidi(scoreDocument: unknown): Promise<{ midiBase64: string }> {
    await this.ensureEngine();
    const client = this.client;
    if (!client) {
      throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "no engine client");
    }
    return client.call<{ midiBase64: string }>("export.midi", {
      scoreDocument,
    });
  }

  // ---- jobs --------------------------------------------------------------------

  /** The jobKind to request: `transcription` when the engine advertises
   *  it, else the spike stand-in (documented bridge). */
  private transcriptionJobKind(): string {
    const kinds = this.snap.capabilities?.jobKinds;
    if (Array.isArray(kinds) && kinds.includes(TRANSCRIPTION_JOB_KIND)) {
      return TRANSCRIPTION_JOB_KIND;
    }
    return FALLBACK_JOB_KIND;
  }

  /**
   * `score.transcribe` → `job.start`. Explicit user action only — retry is
   * never silent (issue rule). Resolves once the job is accepted; progress
   * arrives as job.event frames afterwards.
   */
  async startTranscription(params: unknown = {}): Promise<void> {
    if (this.snap.job && !isSettled(this.snap.job)) {
      throw new SidecarError(ERR.JOB_ALREADY_RUNNING, "a job is already running");
    }
    this.update({ failure: null, lastResult: null, reviewIssueCount: 0 });
    await this.ensureEngine();
    const client = this.client;
    if (!client) {
      throw new SidecarError(ERR.ENGINE_UNAVAILABLE, "no engine client");
    }
    const kind = this.transcriptionJobKind();
    let accepted: JobStartResult;
    try {
      accepted = await client.startJob(kind, params);
    } catch (e) {
      // job.start itself was rejected (request timeout, INVALID_PARAMS, a
      // racing JOB_ALREADY_RUNNING). Surface an honest failure rather than
      // leaving the screen on a job that never existed — unless crash
      // supervision already set a stronger one (don't downgrade it).
      if (!this.snap.failure) {
        this.update({
          failure: {
            kind: "transcriptionFailed",
            detail: e instanceof Error ? e.message : String(e),
            errorCode: e instanceof SidecarError ? e.code : undefined,
          },
        });
      }
      throw e;
    }
    this.update({
      job: createJobView(accepted.jobId, kind, this.now()),
    });
  }

  /**
   * `job.cancel` — cooperative (PROTOCOL.md): the job ends in a terminal
   * `cancelled` event at the next checkpoint, so this resolves while the
   * job is still finishing. The UI shows the honest `cancelling` state
   * until the terminal event arrives.
   */
  async cancelTranscription(): Promise<void> {
    const job = this.snap.job;
    const client = this.client;
    if (!job || isSettled(job) || !client) return;
    if (job.phase === "cancelling") return;
    this.update({ job: markCancelling(job) });
    try {
      await client.cancelJob(job.jobId);
    } catch (e) {
      if (e instanceof SidecarError && e.code === ERR.JOB_NOT_FOUND) {
        // The job already reached a terminal event — fine, it wins.
        return;
      }
      // The cancel request itself failed — restore the honest running
      // state so the button does not lie about a pending cancel. Fold the
      // flag back onto the CURRENT view so progress/stage events that
      // arrived in the meantime are not lost.
      const current = this.snap.job;
      if (
        current &&
        current.jobId === job.jobId &&
        current.phase === "cancelling"
      ) {
        this.update({ job: { ...current, phase: "running" } });
      }
      throw e;
    }
    // #233: cooperative cancel is a checkpoint poll — a job inside
    // blocking inference (Basic Pitch / pYIN) cannot check the flag
    // until the call returns, so the terminal event may never arrive
    // within a reasonable window. After the grace period, escalate to
    // the documented terminate+restart fallback: mark the job cancelled
    // (before the kill so the exit path cannot label it a crash), kill
    // the worker, and respawn a fresh engine. Audio, prior scores, and
    // project state all live outside the worker and are untouched.
    const graceDeadline = Date.now() + this.cancelGraceMs;
    while (
      this.snap.job?.jobId === job.jobId &&
      !isSettled(this.snap.job) &&
      Date.now() < graceDeadline
    ) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const afterGrace = this.snap.job;
    if (
      afterGrace &&
      afterGrace.jobId === job.jobId &&
      !isSettled(afterGrace) &&
      this.client === client
    ) {
      this.log(
        `cancel grace ${this.cancelGraceMs}ms elapsed — terminating worker`,
      );
      this.update({
        job: { ...afterGrace, phase: "cancelled" },
      });
      const dying = this.client;
      this.client = null;
      if (dying) await dying.terminate();
      try {
        await this.restartEngine();
      } catch {
        // Restart failure is already surfaced via engine/failure state;
        // the job itself stays honestly cancelled.
      }
    }
  }

  // ---- event/state handling ----------------------------------------------------

  private onJobEvent(event: JobEventPayload): void {
    const job = this.snap.job;
    if (!job || event.jobId !== job.jobId) return;
    const next = reduceJobEvent(job, event);
    const patch: Partial<SessionSnapshot> = { job: next };
    if (next.phase === "completed") {
      patch.lastResult = next.result;
      patch.reviewIssueCount = extractReviewIssueCount(next.result);
    } else if (next.phase === "failed" && next.error) {
      // Engine stayed alive, the job failed → 再試行 surface.
      patch.failure = {
        kind: "transcriptionFailed",
        detail: `${next.error.code}: ${next.error.message}`,
        errorCode: next.error.code,
        // #195: the dependency-missing surface names the package.
        errorPackage: (() => {
          const d = next.error.details;
          if (
            next.error.code !== ERR.ENGINE_DEPENDENCY_MISSING ||
            typeof d !== "object" ||
            d === null
          ) {
            return undefined;
          }
          const pkg = (d as Record<string, unknown>).package;
          return typeof pkg === "string" ? pkg : undefined;
        })(),
      };
    }
    this.update(patch);
  }

  private onClientState(state: string): void {
    switch (state) {
      case "ready":
        this.update({ engine: "ready" });
        break;
      case "starting":
        this.update({ engine: "starting" });
        break;
      case "closed":
        this.update({ engine: "closed" });
        break;
      case "crashed":
      case "unresponsive": {
        const engine = state as EngineStatus;
        const kind: FailureKind =
          state === "crashed" ? "workerCrashed" : "workerNotResponding";
        const code =
          state === "crashed" ? ERR.WORKER_CRASHED : ERR.WORKER_UNRESPONSIVE;
        const job = this.snap.job;
        const patch: Partial<SessionSnapshot> = { engine };
        // ADR-0002: an in-flight job gets NO terminal event from a dead
        // worker — the supervisor marks it failed explicitly.
        if (job && !isSettled(job)) {
          patch.job = markJobDead(job, {
            code,
            message:
              state === "crashed"
                ? "worker process exited while the job was in flight"
                : "worker did not answer the watchdog probe",
          });
          patch.failure = { kind, detail: code, errorCode: code };
        } else if (this.snap.engine === "ready" || this.snap.engine === "starting") {
          // Idle-engine death is reported through `engine` alone — the
          // status bar shows it; no modal error for a silent worker.
        }
        this.update(patch);
        break;
      }
    }
  }

  // ---- terminal bookkeeping ------------------------------------------------------

  /**
   * Clear the settled job record after the UI has consumed the terminal
   * state (completed → scoreReady handoff, cancelled → audioReady). The
   * `lastResult` handoff payload is preserved.
   */
  clearJob(): void {
    const job = this.snap.job;
    if (job && isSettled(job)) this.update({ job: null });
  }

  /** Dismiss the failure surface — the workspace returns to its prior
   *  valid state (audio stays loaded, a prior score is never destroyed). */
  clearFailure(): void {
    if (this.snap.failure) this.update({ failure: null });
  }

  /** Diagnostics text for the 診断情報 dialog (GUI_UX_SPEC §19 fields the
   *  session can honestly report; tool checks belong to UI-060). */
  buildDiagnostics(): string {
    const s = this.snap;
    const correction = extractAlignmentCorrection(s.lastResult);
    const lines: string[] = [
      "HornScribe desktop — transcription session",
      `protocolVersion: ${s.protocolVersion ?? "?"}`,
      `engine: ${s.engine}`,
      `engineInfo: ${s.engineInfo ? JSON.stringify(s.engineInfo) : "(none)"}`,
      `jobKinds: ${JSON.stringify(s.capabilities?.jobKinds ?? [])}`,
      `cooperativeCancel: ${String(s.capabilities?.cooperativeCancel ?? "?")}`,
      `cancellationFallback: ${String(s.capabilities?.cancellationFallback ?? "?")}`,
      `job: ${s.job ? `${s.job.jobId} ${s.job.phase}` : "(none)"}`,
      `failure: ${s.failure ? `${s.failure.kind} (${s.failure.detail})` : "(none)"}`,
      ...(correction !== null ? [correction] : []),
      "— recent engine diagnostics —",
      ...s.diagnostics.slice(-30),
    ];
    return lines.join("\n");
  }
}

function isSettled(job: JobView): boolean {
  return (
    job.phase === "completed" ||
    job.phase === "cancelled" ||
    job.phase === "failed"
  );
}

/**
 * #81: `result.meta.alignmentShiftSec` — the onset-lattice timing
 * correction the quantizer applied, surfaced on the diagnostics sheet
 * so a "the written notes sat off the recorded beat" question has a
 * visible, numeric answer. Silent when absent (older engine), not a
 * finite number, or exactly zero — no applied correction is the normal
 * case and the sheet stays noise-free. `alignmentMeterResolved` marks
 * corrections whose phase was disambiguated by metrical evidence
 * (quantizer tie-break) rather than a plain residual minimum.
 */
function extractAlignmentCorrection(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const meta = (result as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const shift = m.alignmentShiftSec;
  if (typeof shift !== "number" || !Number.isFinite(shift) || shift === 0) {
    return null;
  }
  const sign = shift >= 0 ? "+" : "";
  const tag = m.alignmentMeterResolved === true ? " (meter-resolved)" : "";
  return `timingCorrectionSec: ${sign}${shift.toFixed(4)}${tag}`;
}
