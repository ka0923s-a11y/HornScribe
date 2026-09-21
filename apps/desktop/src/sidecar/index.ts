/**
 * src/sidecar — NDJSON sidecar client for the HornScribe engine worker.
 * See README.md for the transport story and the packaged-app gate.
 */
export {
  PROTOCOL_VERSION,
  ERR,
  SidecarError,
  requestFrame,
  encodeFrame,
  parseInboundFrame,
  isTerminalPhase,
} from "./protocol";
export type {
  Envelope,
  ProtocolErrorObject,
  ErrorCode,
  EngineInfo,
  EngineCapabilities,
  HandshakeResult,
  PingResult,
  ShutdownResult,
  JobStartResult,
  JobCancelResult,
  JobEventPayload,
  JobPhase,
  JobTerminalPhase,
} from "./protocol";

export {
  createDefaultSidecarPort,
  UnsupportedSidecarPort,
} from "./port";
export type { SidecarPort } from "./port";

export { MockSidecarPort } from "./mockPort";
export type { MockSidecarOptions } from "./mockPort";

export { SidecarClient } from "./client";
export type { SidecarClientOptions, SidecarClientState } from "./client";

export {
  TRANSCRIPTION_STAGE_IDS,
  createJobView,
  reduceJobEvent,
  markCancelling,
  markJobDead,
  initialStages,
} from "./jobView";
export type {
  TranscriptionStageId,
  StageStatus,
  StageView,
  JobView,
  JobViewPhase,
} from "./jobView";

export {
  REVIEW_REASONS,
  REVIEW_REASON_COPY_KEYS,
  REVIEW_SEVERITIES,
  REVIEW_ISSUE_STATUSES,
  reviewReasonCopyKey,
  extractReviewIssues,
  extractReviewIssueCount,
  isReviewIssuePayload,
} from "./review";
export type {
  ReviewReason,
  ReviewReasonCopyKey,
  ReviewSeverity,
  ReviewIssueStatus,
  ReviewIssuePayload,
} from "./review";

export {
  TranscriptionSession,
  TRANSCRIPTION_JOB_KIND,
  FALLBACK_JOB_KIND,
} from "./session";
export type {
  TranscriptionSessionOptions,
  SessionSnapshot,
  SessionFailure,
  FailureKind,
  EngineStatus,
} from "./session";
