/**
 * Client-side mirror of the HornScribe NDJSON sidecar protocol
 * (protocol/PROTOCOL.md, implemented engine-side by
 * python/hornscribe/worker/protocol.py).
 *
 * Transport: one JSON envelope per line over the sidecar's stdin/stdout;
 * stderr is diagnostics only. Unknown additive fields are ignored safely
 * (ADR-0002), so every payload type below carries an index signature.
 */

/** Wire protocol version implemented by this client. */
export const PROTOCOL_VERSION = 1;

/** Structured error object carried inside an envelope or a job event. */
export interface ProtocolErrorObject {
  code: string;
  message: string;
  details?: unknown;
}

export type FrameKind = "request" | "response" | "event";

/** The wire envelope — a single JSON object per NDJSON line. */
export interface Envelope {
  v: number;
  id: string | null;
  kind: FrameKind;
  method: string | null;
  payload: unknown;
  error: ProtocolErrorObject | null;
}

/**
 * Error codes. UPPER_SNAKE per PROTOCOL.md. The first block mirrors
 * python/hornscribe/worker/protocol.py exactly; the second block is
 * shell-side supervision codes that never appear on the wire — they mark
 * failures the supervisor (this client) detected itself, mirroring how the
 * UI-002 test harness marks an in-flight job failed when the worker dies
 * mid-job (ADR-0002: never silently resubmitted).
 */
export const ERR = {
  PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH",
  MALFORMED_MESSAGE: "MALFORMED_MESSAGE",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INVALID_PARAMS: "INVALID_PARAMS",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JOB_ALREADY_RUNNING: "JOB_ALREADY_RUNNING",
  UNKNOWN_JOB_KIND: "UNKNOWN_JOB_KIND",
  JOB_TIMEOUT: "JOB_TIMEOUT",
  JOB_FAILED: "JOB_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // ---- shell-side supervision codes (not wire codes) ----
  /** The worker process exited without a graceful shutdown. */
  WORKER_CRASHED: "WORKER_CRASHED",
  /** Watchdog: the worker stopped answering while a job was in flight. */
  WORKER_UNRESPONSIVE: "WORKER_UNRESPONSIVE",
  /** A request received no response within its timeout. */
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  /** The sidecar transport could not be started (e.g. spawn gate). */
  ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  /** A request was issued while the client was not in `ready` state. */
  ENGINE_NOT_READY: "ENGINE_NOT_READY",
} as const;

export type ErrorCode = (typeof ERR)[keyof typeof ERR];

/** Structured failure raised by the client — converts an error object to
 *  an exception so callers can `catch` instead of checking envelopes. */
export class SidecarError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.details = details;
  }
}

// ---- envelope builders (client → worker) -----------------------------

export function requestFrame(
  id: string,
  method: string,
  payload: unknown,
): Envelope {
  return { v: PROTOCOL_VERSION, id, kind: "request", method, payload, error: null };
}

/** Serialize an envelope to a single NDJSON line (no trailing newline —
 *  the port adds it). JSON.stringify escapes control characters so the
 *  output can never contain a raw newline. */
export function encodeFrame(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

// ---- inbound parsing ---------------------------------------------------

/**
 * Parse one inbound NDJSON line into an Envelope, or return null when the
 * frame is too malformed to use. Client-side parsing is deliberately
 * tolerant about *content* (unknown fields pass through per ADR-0002) but
 * strict about envelope shape: a frame we cannot route is dropped and
 * reported through the diagnostics channel, never answered.
 */
export function parseInboundFrame(line: string): Envelope | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const frame = raw as Record<string, unknown>;
  if (frame.v !== PROTOCOL_VERSION) return null;
  const kind = frame.kind;
  if (kind !== "response" && kind !== "event") {
    // The worker only ever sends responses and events; anything else
    // (including inbound "request") is logged and dropped, never answered.
    return null;
  }
  const id = frame.id;
  const method = frame.method;
  if (kind === "response") {
    // A response carries the request id — except the single sanctioned
    // `id: null` case (worker could not recover an id from our frame),
    // which also arrives with `method: null`.
    if (id !== null && (typeof id !== "string" || !id)) return null;
    if (id === null) {
      if (method !== null && method !== undefined && typeof method !== "string") {
        return null;
      }
    } else if (typeof method !== "string" || !method) {
      return null;
    }
  } else {
    // Events must carry exactly `id: null` and a non-empty method.
    if (id !== null) return null;
    if (typeof method !== "string" || !method) return null;
  }
  const error = normalizeError(frame.error);
  return {
    v: PROTOCOL_VERSION,
    id: (id as string | null) ?? null,
    kind,
    // `undefined` (absent field) normalizes to null — the wire contract
    // always carries the key, but a tolerantly-typed frame may omit it.
    method: (method as string | null | undefined) ?? null,
    payload: frame.payload,
    error,
  };
}

function normalizeError(raw: unknown): ProtocolErrorObject | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.code !== "string" || typeof e.message !== "string") return null;
  return { code: e.code, message: e.message, details: e.details };
}

// ---- method payloads -----------------------------------------------------

export interface EngineInfo {
  name?: string;
  version?: string;
  python?: string;
  platform?: string;
  pid?: number;
  [key: string]: unknown;
}

export interface EngineCapabilities {
  methods?: string[];
  jobKinds?: string[];
  maxConcurrentJobs?: number;
  cooperativeCancel?: boolean;
  cancellationFallback?: string;
  progressEvents?: boolean;
  basicPitchAvailable?: boolean;
  [key: string]: unknown;
}

export interface HandshakeResult {
  protocolVersion: number;
  engineInfo: EngineInfo;
  capabilities: EngineCapabilities;
  [key: string]: unknown;
}

export interface PingResult {
  echo: unknown;
  workerPid?: number;
  uptimeMs?: number;
  [key: string]: unknown;
}

export interface ShutdownResult {
  ok: boolean;
  activeJob: string | null;
  [key: string]: unknown;
}

export interface JobStartResult {
  jobId: string;
  jobKind: string;
  state: string;
  [key: string]: unknown;
}

export interface JobCancelResult {
  jobId: string;
  cancellation: string;
  [key: string]: unknown;
}

/** `job.event` terminal phases: exactly one ends every job. */
export type JobTerminalPhase = "completed" | "cancelled" | "failed";
export type JobPhase = "started" | "progress" | JobTerminalPhase;

/**
 * `job.event` payload (kind=event, id=null).
 *
 * [UI-040] additive fields beyond the UI-002 spike contract:
 * - `stage`: pipeline stage id (TRANSCRIPTION_STAGE_IDS) reported by jobs
 *   that can name their position honestly. Absent for stage-less jobs
 *   (e.g. `demoLongTask` on the spike worker) — the UI must not infer one.
 * - `result.reviewIssues` on `completed`: ReviewIssue dicts
 *   (python/hornscribe/domain/review.py `ReviewIssue.to_dict`).
 */
export interface JobEventPayload {
  jobId: string;
  jobKind?: string;
  phase: JobPhase;
  /** Real 0–1 job fraction when the engine can compute one — may be absent. */
  progress?: number;
  /** [UI-040] current pipeline stage id — absent when unknown. */
  stage?: string;
  step?: number;
  totalSteps?: number;
  /** `failed` terminal events carry the job error here (envelope error stays null). */
  error?: ProtocolErrorObject;
  /** `completed` events may carry the job result payload. */
  result?: unknown;
  [key: string]: unknown;
}

export function isTerminalPhase(phase: string): phase is JobTerminalPhase {
  return phase === "completed" || phase === "cancelled" || phase === "failed";
}
