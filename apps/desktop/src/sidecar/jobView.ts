/**
 * Job-event → view-state tracker (GUI_UX_SPEC §5).
 *
 * Pure reducer: it folds `job.event` payloads into the stage list +
 * progress the transcribing screen renders. Honesty rules from the spec
 * and JAPANESE_UI_COPY §5 are enforced structurally here:
 *
 * - a stage is only `done`/`active` when the engine actually reported it —
 *   jobs without `stage` fields (e.g. `demoLongTask` on the spike worker)
 *   leave every stage pending and the UI must not fake a position;
 * - `progress` is only set when the engine emitted a real fraction;
 * - exactly one terminal phase ends the job (`completed` | `cancelled` |
 *   `failed`); later events for the same job are ignored.
 */

import {
  ERR,
  type JobEventPayload,
  type ProtocolErrorObject,
} from "./protocol";

/** Engine pipeline stage ids — keys of `transcription.stages.*` in the
 *  copy deck (protocol/copy/ja-JP.json), in pipeline order. */
export const TRANSCRIPTION_STAGE_IDS = [
  "preparing_audio",
  "transcribing",
  "cleaning",
  "analyzing_rhythm",
  "quantizing",
  "building_score",
  "rendering",
] as const;

export type TranscriptionStageId = (typeof TRANSCRIPTION_STAGE_IDS)[number];

export type StageStatus = "pending" | "active" | "done";

export interface StageView {
  id: TranscriptionStageId;
  status: StageStatus;
}

export type JobViewPhase =
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * What the transcribing screen renders for one in-flight (or just-ended)
 * job. `stages` always lists all seven stages; `progress` is the engine's
 * real fraction or null (indeterminate).
 */
export interface JobView {
  jobId: string;
  jobKind: string;
  phase: JobViewPhase;
  stages: StageView[];
  /** Real 0–1 fraction reported by the engine, else null → indeterminate. */
  progress: number | null;
  /** Index of the active stage, or -1 when the engine reports no stages. */
  activeStageIndex: number;
  /** Whether any `stage` field has been seen for this job. */
  hasStageInfo: boolean;
  /** Job-level error from the terminal `failed` event. */
  error: ProtocolErrorObject | null;
  /** `completed` payload — the score-data handoff consumed by UI-030. */
  result: unknown;
  startedAt: number;
}

export function initialStages(): StageView[] {
  return TRANSCRIPTION_STAGE_IDS.map((id) => ({ id, status: "pending" }));
}

export function createJobView(
  jobId: string,
  jobKind: string,
  startedAt: number,
): JobView {
  return {
    jobId,
    jobKind,
    phase: "running",
    stages: initialStages(),
    progress: null,
    activeStageIndex: -1,
    hasStageInfo: false,
    error: null,
    result: null,
    startedAt,
  };
}

function clampProgress(raw: unknown): number | null {
  if (typeof raw !== "number" || Number.isNaN(raw)) return null;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Fold one `job.event` payload into the tracked view. Returns a new
 * JobView (immutably) so React state updates stay shallow-comparable.
 * Events for a different job, or events after a terminal phase, are
 * ignored (the worker emits exactly one terminal phase per job).
 */
export function reduceJobEvent(view: JobView, event: JobEventPayload): JobView {
  if (event.jobId !== view.jobId) return view;
  if (
    view.phase === "completed" ||
    view.phase === "cancelled" ||
    view.phase === "failed"
  ) {
    return view;
  }

  let { stages, activeStageIndex, hasStageInfo, progress } = view;

  const realProgress = clampProgress(event.progress);
  if (realProgress !== null) progress = realProgress;

  // [UI-040] `stage` is the only honest way to move the stage list — the
  // engine tells us where it is; we never guess from elapsed time.
  if (typeof event.stage === "string") {
    const idx = (TRANSCRIPTION_STAGE_IDS as readonly string[]).indexOf(
      event.stage,
    );
    if (idx >= 0) {
      hasStageInfo = true;
      // Stages only move forward — a job cannot un-finish a stage, so a
      // backwards `stage` is ignored rather than presented as progress.
      if (idx > activeStageIndex) {
        stages = stages.map((s, i) => ({
          ...s,
          status: i < idx ? "done" : i === idx ? "active" : "pending",
        }));
        activeStageIndex = idx;
      }
    }
  }

  switch (event.phase) {
    case "completed":
      return {
        ...view,
        phase: "completed",
        stages: stages.map((s) => ({ ...s, status: "done" })),
        progress: 1,
        activeStageIndex: stages.length - 1,
        hasStageInfo,
        error: null,
        result: event.result ?? null,
      };
    case "cancelled":
      return {
        ...view,
        phase: "cancelled",
        stages,
        progress,
        activeStageIndex,
        hasStageInfo,
        error: null,
      };
    case "failed":
      return {
        ...view,
        phase: "failed",
        stages,
        progress,
        activeStageIndex,
        hasStageInfo,
        error: event.error ?? {
          code: ERR.JOB_FAILED,
          message: "job failed without an error object",
        },
      };
    default:
      // started | progress — running view.
      return {
        ...view,
        stages,
        progress,
        activeStageIndex,
        hasStageInfo,
      };
  }
}

/**
 * Mark a cancel request as in-flight. The job is NOT done yet — the
 * terminal `cancelled` event is what ends it (cooperative cancel is a
 * request, not an instant kill); the UI shows an honest pending state in
 * the meantime.
 */
export function markCancelling(view: JobView): JobView {
  if (view.phase !== "running") return view;
  return { ...view, phase: "cancelling" };
}

/**
 * Supervisor-synthesized terminal failure (ADR-0002): when the worker
 * crashes or goes unresponsive mid-job, the engine never emits a terminal
 * event — the supervisor marks the job failed explicitly instead. This is
 * the same policy the UI-002 harness applies to killed workers.
 */
export function markJobDead(view: JobView, error: ProtocolErrorObject): JobView {
  if (
    view.phase === "completed" ||
    view.phase === "cancelled" ||
    view.phase === "failed"
  ) {
    return view;
  }
  return { ...view, phase: "failed", error };
}
