/**
 * TranscriptionSession + jobView tracker tests (UI-040).
 *
 * Covers the app-facing state machine: start → stage/progress tracking →
 * terminal transitions, cooperative cancel with the honest `cancelling`
 * state, job failure → 再試行 surface, worker crash/unresponsive →
 * エンジンを再起動 recovery, review-issue count extraction, and the
 * stage-honesty rules (no `stage` field → no claimed position).
 */

import { describe, expect, it } from "vitest";
import { MockSidecarPort } from "./mockPort";
import {
  TranscriptionSession,
  type SessionSnapshot,
} from "./session";
import {
  createJobView,
  initialStages,
  markCancelling,
  markJobDead,
  reduceJobEvent,
  TRANSCRIPTION_STAGE_IDS,
} from "./jobView";
import {
  extractReviewIssueCount,
  reviewReasonCopyKey,
} from "./review";
import { ERR, type JobEventPayload } from "./protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(2);
  }
}

function makeSession(port = new MockSidecarPort()) {
  const session = new TranscriptionSession({
    portFactory: () => port,
    clientOptions: {
      requestTimeoutMs: 250,
      handshakeTimeoutMs: 500,
      watchdogMs: 40,
      pingTimeoutMs: 30,
    },
  });
  const snaps: SessionSnapshot[] = [];
  session.subscribe((s) => snaps.push(s));
  return { session, port, snaps };
}

const FAST = { steps: 7, stepDurationMs: 2 };

describe("jobView tracker (pure)", () => {
  const ev = (over: Partial<JobEventPayload>): JobEventPayload => ({
    jobId: "job-1",
    phase: "progress",
    ...over,
  });

  it("stages advance only on reported stage fields, in order", () => {
    let v = createJobView("job-1", "transcription", 0);
    expect(v.stages.every((s) => s.status === "pending")).toBe(true);
    v = reduceJobEvent(v, ev({ stage: "preparing_audio" }));
    expect(v.stages[0].status).toBe("active");
    v = reduceJobEvent(v, ev({ stage: "quantizing", progress: 0.6 }));
    expect(v.stages[0].status).toBe("done");
    expect(v.stages[4].status).toBe("active");
    expect(v.activeStageIndex).toBe(4);
    expect(v.progress).toBeCloseTo(0.6);
  });

  it("ignores unknown stage ids and out-of-order noise safely", () => {
    let v = createJobView("job-1", "transcription", 0);
    v = reduceJobEvent(v, ev({ stage: "not_a_stage" }));
    expect(v.stages.every((s) => s.status === "pending")).toBe(true);
    expect(v.hasStageInfo).toBe(false);
    // A stage going "backwards" is ignored (monotonic honesty).
    v = reduceJobEvent(v, ev({ stage: "building_score" }));
    v = reduceJobEvent(v, ev({ stage: "preparing_audio" }));
    expect(v.activeStageIndex).toBe(5);
  });

  it("a job without stage info stays honest (all pending, real progress)", () => {
    let v = createJobView("job-1", "demoLongTask", 0);
    v = reduceJobEvent(v, ev({ progress: 0.4 }));
    v = reduceJobEvent(v, ev({ progress: 0.7 }));
    expect(v.hasStageInfo).toBe(false);
    expect(v.stages.every((s) => s.status === "pending")).toBe(true);
    expect(v.progress).toBeCloseTo(0.7);
  });

  it("terminal completed marks every stage done; later events are ignored", () => {
    let v = createJobView("job-1", "transcription", 0);
    v = reduceJobEvent(v, ev({ stage: "transcribing" }));
    v = reduceJobEvent(v, ev({ phase: "completed", result: { ok: true } }));
    expect(v.phase).toBe("completed");
    expect(v.stages.every((s) => s.status === "done")).toBe(true);
    const after = reduceJobEvent(v, ev({ stage: "preparing_audio" }));
    expect(after.stages[0].status).toBe("done"); // unchanged
  });

  it("failed carries the job error; cancelled preserves position", () => {
    let v = createJobView("job-1", "transcription", 0);
    v = reduceJobEvent(v, ev({ stage: "cleaning" }));
    const f = reduceJobEvent(
      v,
      ev({ phase: "failed", error: { code: "JOB_FAILED", message: "x" } }),
    );
    expect(f.phase).toBe("failed");
    expect(f.error?.code).toBe("JOB_FAILED");
    expect(f.stages[2].status).toBe("active"); // where it died
    const c = reduceJobEvent(v, ev({ phase: "cancelled" }));
    expect(c.phase).toBe("cancelled");
    expect(c.stages[2].status).toBe("active");
  });

  it("markCancelling only applies while running; markJobDead is terminal", () => {
    let v = createJobView("job-1", "transcription", 0);
    v = markCancelling(v);
    expect(v.phase).toBe("cancelling");
    const dead = markJobDead(v, { code: ERR.WORKER_CRASHED, message: "x" });
    expect(dead.phase).toBe("failed");
    expect(dead.error?.code).toBe(ERR.WORKER_CRASHED);
    // A settled job is never resurrected.
    const done = reduceJobEvent(dead, {
      jobId: "job-1",
      phase: "completed",
    });
    expect(done.phase).toBe("failed");
  });

  it("stage ids cover the copy deck order (7 stages)", () => {
    expect(TRANSCRIPTION_STAGE_IDS).toEqual([
      "preparing_audio",
      "transcribing",
      "cleaning",
      "analyzing_rhythm",
      "quantizing",
      "building_score",
      "rendering",
    ]);
    expect(initialStages()).toHaveLength(7);
  });
});

describe("review contract", () => {
  it("extracts the open-issue count from a completed result", () => {
    expect(
      extractReviewIssueCount({ reviewIssues: [{ id: "ri-1", reason: "x" }] }),
    ).toBe(1);
    expect(extractReviewIssueCount({ reviewIssueCount: 5 })).toBe(5);
    expect(extractReviewIssueCount({})).toBe(0);
    expect(extractReviewIssueCount(null)).toBe(0);
    expect(extractReviewIssueCount({ reviewIssues: "nope" })).toBe(0);
  });

  it("maps known reasons to deck keys, unknown to 'other'", () => {
    expect(reviewReasonCopyKey("quantization_ambiguous")).toBe(
      "quantization_ambiguous",
    );
    expect(reviewReasonCopyKey("low_model_confidence")).toBe(
      "low_model_confidence",
    );
    expect(reviewReasonCopyKey("future_reason_x")).toBe("other");
  });
});

describe("TranscriptionSession", () => {
  it("starts the engine lazily and runs a job to completion", async () => {
    const { session, snaps } = makeSession();
    await session.startTranscription(FAST);
    expect(session.getSnapshot().engine).toBe("ready");
    await until(() => session.getSnapshot().job?.phase === "completed");
    const s = session.getSnapshot();
    expect(s.reviewIssueCount).toBe(3); // mock transcription result
    expect(s.lastResult).toMatchObject({ scoreRevision: "sr-mock-0001" });
    // Stages advanced through the pipeline for a stage-aware kind.
    const job = s.job!;
    expect(job.stages.every((st) => st.status === "done")).toBe(true);
    expect(snaps.some((x) => x.engine === "starting")).toBe(true);
    await session.dispose();
  });

  it("falls back to demoLongTask when the engine lacks 'transcription'", async () => {
    const port = new MockSidecarPort({ jobKinds: ["demoLongTask"] });
    const { session } = makeSession(port);
    await session.startTranscription({ steps: 2, stepDurationMs: 1 });
    const job = session.getSnapshot().job;
    expect(job?.jobKind).toBe("demoLongTask");
    await until(() => session.getSnapshot().job?.phase === "completed");
    await session.dispose();
  });

  it("cancel → cancelling (honest pending) → terminal cancelled", async () => {
    const { session, snaps } = makeSession();
    await session.startTranscription({ steps: 50, stepDurationMs: 4 });
    await until(() => session.getSnapshot().job?.phase === "running");
    await session.cancelTranscription();
    // The ack turns the view to cancelling BEFORE the terminal event —
    // the button's pending state is honest, not instant.
    expect(snaps.some((s) => s.job?.phase === "cancelling")).toBe(true);
    await until(() => session.getSnapshot().job?.phase === "cancelled");
    await session.dispose();
  });

  it("job failure sets transcriptionFailed (再試行 surface), engine stays ready", async () => {
    const { session } = makeSession();
    await session.startTranscription({
      steps: 10,
      stepDurationMs: 2,
      failAtStep: 2,
    });
    await until(() => session.getSnapshot().failure !== null);
    const s = session.getSnapshot();
    expect(s.failure?.kind).toBe("transcriptionFailed");
    expect(s.job?.phase).toBe("failed");
    expect(s.engine).toBe("ready"); // engine alive → retry is meaningful
    await session.dispose();
  });

  it("explicit retry after failure runs a fresh job", async () => {
    const { session } = makeSession();
    await session.startTranscription({ steps: 10, stepDurationMs: 2, failAtStep: 2 });
    await until(() => session.getSnapshot().failure !== null);
    session.clearFailure();
    await session.startTranscription(FAST); // explicit retry — never silent
    await until(() => session.getSnapshot().job?.phase === "completed");
    expect(session.getSnapshot().failure).toBeNull();
    await session.dispose();
  });

  it("a mid-job crash fails the job and offers workerCrashed recovery", async () => {
    const { session, port } = makeSession();
    await session.startTranscription({ steps: 100, stepDurationMs: 5 });
    await until(
      () => (session.getSnapshot().job?.progress ?? 0) > 0,
    );
    port.simulateCrash();
    await until(() => session.getSnapshot().failure !== null);
    const s = session.getSnapshot();
    expect(s.engine).toBe("crashed");
    expect(s.failure?.kind).toBe("workerCrashed");
    // ADR-0002: the job is marked failed by the supervisor — the worker
    // emitted no terminal event.
    expect(s.job?.phase).toBe("failed");
    expect(s.job?.error?.code).toBe(ERR.WORKER_CRASHED);
    await session.dispose();
  });

  it("restartEngine recovers a crashed worker with a fresh handshake", async () => {
    const port = new MockSidecarPort();
    let n = 0;
    const session = new TranscriptionSession({
      portFactory: () => (n++ === 0 ? port : new MockSidecarPort()),
      clientOptions: { watchdogMs: 40, pingTimeoutMs: 30 },
    });
    await session.startTranscription({ steps: 100, stepDurationMs: 5 });
    await until(() => (session.getSnapshot().job?.progress ?? 0) > 0);
    port.simulateCrash();
    await until(() => session.getSnapshot().engine === "crashed");
    await session.restartEngine();
    const s = session.getSnapshot();
    expect(s.engine).toBe("ready");
    expect(s.engineInfo?.name).toBe("hornscribe-engine");
    // The dead job is NOT silently resubmitted — user decides.
    await session.dispose();
  });

  it("watchdog unresponsiveness mid-job sets workerNotResponding", async () => {
    const { session, port } = makeSession();
    await session.startTranscription({ steps: 100, stepDurationMs: 5 });
    await until(() => (session.getSnapshot().job?.progress ?? 0) > 0);
    port.simulateHang();
    await until(() => session.getSnapshot().failure !== null, 2000);
    const s = session.getSnapshot();
    expect(s.engine).toBe("unresponsive");
    expect(s.failure?.kind).toBe("workerNotResponding");
    expect(s.job?.error?.code).toBe(ERR.WORKER_UNRESPONSIVE);
    await session.dispose();
  });

  it("an idle crash reports engine state without a failure surface", async () => {
    const { session, port } = makeSession();
    await session.startTranscription(FAST);
    await until(() => session.getSnapshot().job?.phase === "completed");
    session.clearJob();
    port.simulateCrash();
    await until(() => session.getSnapshot().engine === "crashed");
    // No job in flight → no modal error; the status bar shows the crash.
    expect(session.getSnapshot().failure).toBeNull();
    await session.dispose();
  });

  it("double start while a job is running is rejected", async () => {
    const { session } = makeSession();
    await session.startTranscription({ steps: 50, stepDurationMs: 5 });
    await expect(session.startTranscription(FAST)).rejects.toMatchObject({
      code: ERR.JOB_ALREADY_RUNNING,
    });
    await session.dispose();
  });

  it("a job.start that gets no response fails honestly (no stuck screen)", async () => {
    const { session, port } = makeSession();
    // Warm the engine to ready, then wedge it before the next start so
    // job.start itself times out — the screen must land on the failure
    // surface, not on a phantom running job.
    await session.startTranscription({ steps: 1, stepDurationMs: 1 });
    await until(() => session.getSnapshot().job?.phase === "completed");
    session.clearJob();
    port.simulateHang();
    await expect(
      session.startTranscription({ steps: 5, stepDurationMs: 5 }),
    ).rejects.toMatchObject({ code: ERR.REQUEST_TIMEOUT });
    const s = session.getSnapshot();
    expect(s.failure?.kind).toBe("transcriptionFailed");
    expect(s.job).toBeNull();
    await session.dispose();
  });
});
