/**
 * #18: TranscriptionQueue — 逐次実行・結果捕捉・並び替え・キャンセル。
 * フェイクセッションで job ライフサイクルをスクリプト化する。
 */
import { describe, expect, it, vi } from "vitest";
import { TranscriptionQueue, type QueueSession } from "./controller";
import type { SessionSnapshot } from "../sidecar/session";
import type { JobView } from "../sidecar/jobView";
import type { QueueSnapshot } from "./types";

function jobView(phase: JobView["phase"], extra: Partial<JobView> = {}): JobView {
  return {
    jobId: "j1",
    jobKind: "transcription",
    phase,
    stages: [],
    progress: null,
    stepCount: null,
    activeStageIndex: -1,
    hasStageInfo: false,
    error: null,
    result: null,
    startedAt: 0,
    ...extra,
  };
}

interface FakeSession extends QueueSession {
  snap: SessionSnapshot;
  emit(): void;
  complete(result: unknown): void;
  progress(p: number): void;
  fail(detail: string, engineDead?: boolean): void;
}

function makeSession(): FakeSession {
  let counter = 0;
  const subs = new Set<(s: SessionSnapshot) => void>();
  const sess: FakeSession = {
    snap: {
      engine: "ready",
      engineInfo: null,
      protocolVersion: 1,
      capabilities: null,
      job: null,
      failure: null,
      lastResult: null,
      reviewIssueCount: 0,
      diagnostics: [],
    },
    emit() {
      for (const cb of subs) cb(sess.snap);
    },
    getSnapshot: () => sess.snap,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    startTranscription: vi.fn(async () => {
      counter += 1;
      sess.snap = { ...sess.snap, job: jobView("running", { jobId: "j" + counter }) };
      sess.emit();
    }),
    cancelTranscription: vi.fn(async () => {
      if (sess.snap.job) {
        sess.snap = { ...sess.snap, job: jobView("cancelled", { jobId: sess.snap.job.jobId }) };
        sess.emit();
      }
    }),
    clearJob: () => {
      if (sess.snap.job) {
        sess.snap = { ...sess.snap, job: null };
        sess.emit();
      }
    },
    clearFailure: () => {
      if (sess.snap.failure) {
        sess.snap = { ...sess.snap, failure: null };
        sess.emit();
      }
    },
    complete(result: unknown) {
      if (!sess.snap.job) throw new Error("no job");
      sess.snap = {
        ...sess.snap,
        job: jobView("completed", { jobId: sess.snap.job.jobId, result }),
        lastResult: result,
      };
      sess.emit();
    },
    progress(p: number) {
      if (!sess.snap.job) throw new Error("no job");
      sess.snap = { ...sess.snap, job: { ...sess.snap.job, progress: p } };
      sess.emit();
    },
    fail(detail: string, engineDead = false) {
      if (!sess.snap.job) throw new Error("no job");
      sess.snap = {
        ...sess.snap,
        job: jobView("failed", { jobId: sess.snap.job.jobId }),
        failure: {
          kind: engineDead ? "workerCrashed" : "transcriptionFailed",
          detail,
        },
      };
      sess.emit();
    },
  };
  return sess;
}

function makeEvents() {
  const states: QueueSnapshot[] = [];
  const announces: string[] = [];
  const events = {
    onState: (s: QueueSnapshot) => states.push(s),
    announce: (m: string) => announces.push(m),
    onJobStart: vi.fn(),
    onRunFinished: vi.fn(),
  };
  return { events, states, announces };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const entryParams = { audioPath: "/tmp/a.wav" };

describe("TranscriptionQueue", () => {
  it("enqueue appends pending entries in order", () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    const snap = q.getSnapshot();
    expect(snap.entries.map((e) => e.label)).toEqual(["a.wav", "b.wav"]);
    expect(snap.entries.every((e) => e.status === "pending")).toBe(true);
    q.dispose();
  });

  it("runs entries sequentially and captures each result", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    const run = q.start();
    await tick();
    expect(q.getSnapshot().entries[0].status).toBe("running");
    sess.complete({ musicXml: "<a/>" });
    await tick();
    // 2番目のジョブが自動で始まる。
    expect(q.getSnapshot().entries[1].status).toBe("running");
    sess.complete({ musicXml: "<b/>" });
    await run;
    const snap = q.getSnapshot();
    expect(snap.entries[0].status).toBe("done");
    expect(snap.entries[0].result).toEqual({ musicXml: "<a/>" });
    expect(snap.entries[1].status).toBe("done");
    expect(snap.entries[1].result).toEqual({ musicXml: "<b/>" });
    expect(snap.running).toBe(false);
    expect(sess.startTranscription).toHaveBeenCalledTimes(2);
    expect(events.onRunFinished).toHaveBeenCalled();
    q.dispose();
  });

  it("mirrors job progress onto the running entry", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    const run = q.start();
    await tick();
    sess.progress(0.4);
    expect(q.getSnapshot().entries[0].progress).toBe(0.4);
    sess.complete({});
    await run;
    q.dispose();
  });

  it("a failed entry is recorded and the run continues", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "bad.wav", params: entryParams });
    q.enqueue({ label: "ok.wav", params: entryParams });
    const run = q.start();
    await tick();
    sess.fail("decode blew up");
    await tick();
    expect(q.getSnapshot().entries[0].status).toBe("failed");
    expect(q.getSnapshot().entries[0].error).toBe("decode blew up");
    // ジョブ単位の失敗は消費済み — failure が残って画面をハイジャックしない。
    expect(sess.snap.failure).toBeNull();
    expect(q.getSnapshot().entries[1].status).toBe("running");
    sess.complete({});
    await run;
    expect(q.getSnapshot().entries[1].status).toBe("done");
    q.dispose();
  });

  it("engine-dead failure stops the run and keeps the failure flag", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    const run = q.start();
    await tick();
    sess.fail("worker died", true);
    await run;
    const snap = q.getSnapshot();
    expect(snap.entries[0].status).toBe("failed");
    expect(snap.entries[1].status).toBe("pending"); // 残りは回さない
    expect(sess.snap.failure?.kind).toBe("workerCrashed");
    q.dispose();
  });

  it("cancel(id) marks a pending entry and cancels the running job", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    const b = q.enqueue({ label: "b.wav", params: entryParams });
    await q.cancel(b.id);
    expect(q.getSnapshot().entries[1].status).toBe("cancelled");
    const run = q.start();
    await tick();
    // 走っている方をキャンセル → session の協調キャンセルが呼ばれる。
    const activeId = q.getSnapshot().activeId;
    if (activeId) await q.cancel(activeId);
    expect(sess.cancelTranscription).toHaveBeenCalled();
    await run;
    expect(q.getSnapshot().entries[0].status).toBe("cancelled");
    q.dispose();
  });

  it("stop() cancels the active job and leaves the rest pending", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    const run = q.start();
    await tick();
    await q.stop();
    await run;
    const snap = q.getSnapshot();
    expect(snap.entries[0].status).toBe("cancelled");
    expect(snap.entries[1].status).toBe("pending");
    q.dispose();
  });

  it("move reorders pending entries only", () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    const a = q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    const c = q.enqueue({ label: "c.wav", params: entryParams });
    expect(q.move(c.id, -1)).toBe(true);
    expect(q.getSnapshot().entries.map((e) => e.label)).toEqual([
      "a.wav",
      "c.wav",
      "b.wav",
    ]);
    expect(q.move(a.id, -1)).toBe(false); // 先頭はこれ以上上がらない
    q.dispose();
  });

  it("remove drops a pending entry, clearFinished drops terminal rows", async () => {
    const sess = makeSession();
    const { events } = makeEvents();
    const q = new TranscriptionQueue(sess, events);
    const a = q.enqueue({ label: "a.wav", params: entryParams });
    q.enqueue({ label: "b.wav", params: entryParams });
    expect(q.remove(a.id)).toBe(true);
    expect(q.getSnapshot().entries).toHaveLength(1);
    const run = q.start();
    await tick();
    sess.complete({});
    await run;
    q.clearFinished();
    expect(q.getSnapshot().entries).toHaveLength(0);
    q.dispose();
  });

  it("refuses to start while a foreign job is in flight", async () => {
    const sess = makeSession();
    const { events, announces } = makeEvents();
    sess.snap = { ...sess.snap, job: jobView("running") };
    const q = new TranscriptionQueue(sess, events);
    q.enqueue({ label: "a.wav", params: entryParams });
    await q.start();
    expect(sess.startTranscription).not.toHaveBeenCalled();
    expect(announces.length).toBeGreaterThan(0);
    q.dispose();
  });
});
