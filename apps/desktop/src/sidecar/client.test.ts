/**
 * SidecarClient ↔ MockSidecarPort tests (UI-040).
 *
 * The mock speaks the real NDJSON contract, so these tests exercise the
 * same supervision semantics the UI-002 harness proved against
 * `python -m hornscribe.worker`: handshake/capabilities, id correlation,
 * progress streaming, cooperative cancel, crash detection, watchdog
 * unresponsiveness, graceful shutdown, malformed-frame containment.
 */

import { describe, expect, it } from "vitest";
import { SidecarClient, type SidecarClientState } from "./client";
import { MockSidecarPort } from "./mockPort";
import {
  ERR,
  PROTOCOL_VERSION,
  type JobEventPayload,
} from "./protocol";
import { UnsupportedSidecarPort } from "./port";

function connect(opts: ConstructorParameters<typeof SidecarClient>[1] = {}) {
  const port = new MockSidecarPort();
  const client = new SidecarClient(port, {
    requestTimeoutMs: 250,
    handshakeTimeoutMs: 500,
    watchdogMs: 40,
    pingTimeoutMs: 30,
    ...opts,
  });
  const events: JobEventPayload[] = [];
  const states: SidecarClientState[] = [];
  const diags: string[] = [];
  client.onJobEvent((e) => events.push(e));
  client.onStateChange((s) => states.push(s));
  client.onDiagnostic((l) => diags.push(l));
  return { port, client, events, states, diags };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(2);
  }
}

describe("handshake + lifecycle", () => {
  it("handshakes and reports protocol version, engine info, capabilities", async () => {
    const { client } = connect();
    const hs = await client.start();
    expect(client.getState()).toBe("ready");
    expect(hs.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hs.engineInfo.name).toBe("hornscribe-engine");
    expect(hs.capabilities.cooperativeCancel).toBe(true);
    expect(hs.capabilities.cancellationFallback).toBe("terminate+restart");
    expect(hs.capabilities.jobKinds).toContain("transcription");
    await client.shutdown();
    expect(client.getState()).toBe("closed");
  });

  it("refuses an incompatible protocol version and the worker exits", async () => {
    const port = new MockSidecarPort();
    await port.start();
    const seen: string[] = [];
    port.onLine((l) => seen.push(l));
    const exited = new Promise<number | null>((r) => port.onExit(r));
    port.writeLine(
      JSON.stringify({
        v: 1,
        id: "req-1",
        kind: "request",
        method: "engine.handshake",
        payload: { protocolVersion: 99 },
        error: null,
      }),
    );
    await until(() => seen.length > 0);
    const resp = JSON.parse(seen[0]);
    expect(resp.error.code).toBe(ERR.PROTOCOL_VERSION_MISMATCH);
    expect(resp.error.details.supported).toEqual([1]);
    expect(await exited).toBe(0); // refusal, not a crash
  });

  it("ping echoes and correlates ids while a job streams events", async () => {
    const { client, events } = connect();
    await client.start();
    await client.startJob("demoLongTask", { steps: 30, stepDurationMs: 5 });
    const pong = await client.ping("hello-42");
    expect(pong.echo).toBe("hello-42");
    expect(pong.workerPid).toBe(4242);
    // Events interleaved with the ping did not disturb correlation.
    expect(events.length).toBeGreaterThan(0);
    await client.shutdown();
  });

  it("requests issued before ready fail with ENGINE_NOT_READY", async () => {
    const { client } = connect();
    await expect(client.ping()).rejects.toMatchObject({
      code: ERR.ENGINE_NOT_READY,
    });
  });
});

describe("job lifecycle", () => {
  it("streams started → progress → completed with a real fraction", async () => {
    const { client, events } = connect();
    await client.start();
    const res = await client.startJob("demoLongTask", {
      steps: 3,
      stepDurationMs: 1,
    });
    expect(res.state).toBe("accepted");
    await until(
      () => events.some((e) => e.phase === "completed"),
    );
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("started");
    expect(phases[phases.length - 1]).toBe("completed");
    // Exactly one terminal event; progress is monotonic and real.
    expect(
      events.filter((e) =>
        ["completed", "cancelled", "failed"].includes(e.phase),
      ),
    ).toHaveLength(1);
    const progresses = events
      .filter((e) => typeof e.progress === "number")
      .map((e) => e.progress as number);
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
    }
    expect(client.inFlightJobs).toHaveLength(0);
    await client.shutdown();
  });

  it("transcription jobs carry stage fields in pipeline order", async () => {
    const { client, events } = connect();
    await client.start();
    await client.startJob("transcription", { steps: 7, stepDurationMs: 1 });
    await until(() => events.some((e) => e.phase === "completed"));
    const stages = events
      .map((e) => e.stage)
      .filter((s): s is string => typeof s === "string");
    expect(stages[0]).toBe("preparing_audio");
    expect(stages).toContain("rendering");
    const done = events.find((e) => e.phase === "completed");
    expect(done?.result).toMatchObject({
      reviewIssues: expect.arrayContaining([
        expect.objectContaining({ reason: "quantization_ambiguous" }),
      ]),
    });
    await client.shutdown();
  });

  it("job.cancel ends the job in a terminal cancelled event", async () => {
    const { client, events } = connect();
    await client.start();
    const res = await client.startJob("demoLongTask", {
      steps: 50,
      stepDurationMs: 5,
    });
    const ack = await client.cancelJob(res.jobId);
    expect(ack.cancellation).toBe("requested");
    await until(() => events.some((e) => e.phase === "cancelled"));
    // Deterministic terminal state: cancelled, exactly once.
    expect(events.filter((e) => e.phase === "cancelled")).toHaveLength(1);
    expect(client.inFlightJobs).toHaveLength(0);
    await client.shutdown();
  });

  it("cancel of a finished/unknown job reports JOB_NOT_FOUND", async () => {
    const { client } = connect();
    await client.start();
    await expect(client.cancelJob("job-9999")).rejects.toMatchObject({
      code: ERR.JOB_NOT_FOUND,
    });
    await client.shutdown();
  });

  it("a second concurrent job is rejected JOB_ALREADY_RUNNING", async () => {
    const { client } = connect();
    await client.start();
    await client.startJob("demoLongTask", { steps: 20, stepDurationMs: 10 });
    await expect(
      client.startJob("demoLongTask", { steps: 1, stepDurationMs: 1 }),
    ).rejects.toMatchObject({ code: ERR.JOB_ALREADY_RUNNING });
    await client.shutdown();
  });

  it("deadlineMs ends the job in failed/JOB_TIMEOUT", async () => {
    const { client, events } = connect();
    await client.start();
    await client.startJob("demoLongTask", {
      steps: 50,
      stepDurationMs: 15,
      deadlineMs: 10,
    });
    await until(() => events.some((e) => e.phase === "failed"));
    const failed = events.find((e) => e.phase === "failed");
    expect(failed?.error?.code).toBe(ERR.JOB_TIMEOUT);
    await client.shutdown();
  });
});

describe("crash + supervision", () => {
  it("a mid-job crash marks the client crashed and kills pending work", async () => {
    const { port, client, events, states } = connect();
    await client.start();
    await client.startJob("demoLongTask", { steps: 100, stepDurationMs: 10 });
    await until(() => events.some((e) => e.phase === "progress"));
    // Wedge the worker so a request stays genuinely in flight, then crash.
    port.simulateHang();
    const pending = client.ping();
    port.simulateCrash();
    await expect(pending).rejects.toMatchObject({
      code: ERR.WORKER_CRASHED,
    });
    await until(() => client.getState() === "crashed");
    expect(states).toContain("crashed");
    // ADR-0002: the in-flight job got NO terminal event from the worker —
    // marking it failed is the session's job (tested in session.test.ts).
    expect(events.some((e) => e.phase === "completed")).toBe(false);
    expect(events.some((e) => e.phase === "cancelled")).toBe(false);
  });

  it("watchdog catches a wedged worker while a job is in flight", async () => {
    const { port, client, events } = connect({ watchdogMs: 40, pingTimeoutMs: 30 });
    await client.start();
    await client.startJob("demoLongTask", { steps: 100, stepDurationMs: 10 });
    await until(() => events.some((e) => e.phase === "progress"));
    port.simulateHang(); // like debug.hang — loop wedges, silence follows
    await until(() => client.getState() === "unresponsive", 2000);
  });

  it("watchdog stays quiet while progress keeps flowing", async () => {
    const { client, events } = connect({ watchdogMs: 60 });
    await client.start();
    await client.startJob("demoLongTask", { steps: 4, stepDurationMs: 10 });
    await until(() => events.some((e) => e.phase === "completed"));
    expect(client.getState()).toBe("ready");
    await client.shutdown();
  });

  it("a request that outlives its timeout rejects REQUEST_TIMEOUT", async () => {
    const { port, client } = connect();
    await client.start();
    port.simulateHang();
    await expect(client.ping()).rejects.toMatchObject({
      code: ERR.REQUEST_TIMEOUT,
    });
  });

  it("UnsupportedSidecarPort fails explicitly — the packaged-app gate", async () => {
    const client = new SidecarClient(new UnsupportedSidecarPort());
    await expect(client.start()).rejects.toMatchObject({
      code: ERR.ENGINE_UNAVAILABLE,
    });
    expect(client.getState()).toBe("crashed");
  });
});

describe("malformed-frame containment (worker contract)", () => {
  it("garbage JSON gets MALFORMED_MESSAGE with null id; worker stays up", async () => {
    const port = new MockSidecarPort();
    await port.start();
    const seen: string[] = [];
    port.onLine((l) => seen.push(l));
    port.writeLine("this is not json{");
    port.writeLine(JSON.stringify({ hello: "world" }));
    await until(() => seen.length >= 2);
    const a = JSON.parse(seen[0]);
    const b = JSON.parse(seen[1]);
    expect(a.error.code).toBe(ERR.MALFORMED_MESSAGE);
    expect(a.id).toBeNull();
    expect(b.error.code).toBe(ERR.MALFORMED_MESSAGE);
    // Still alive and answering.
    port.writeLine(
      JSON.stringify({
        v: 1,
        id: "req-ok",
        kind: "request",
        method: "engine.ping",
        payload: { echo: "still-here" },
        error: null,
      }),
    );
    await until(() => seen.length >= 3);
    expect(JSON.parse(seen[2]).payload.echo).toBe("still-here");
  });

  it("inbound event/response frames to the worker are dropped, not answered", async () => {
    const port = new MockSidecarPort();
    await port.start();
    const seen: string[] = [];
    const errs: string[] = [];
    port.onLine((l) => seen.push(l));
    port.onStderr((l) => errs.push(l));
    port.writeLine(
      JSON.stringify({
        v: 1,
        id: null,
        kind: "event",
        method: "job.event",
        payload: {},
        error: null,
      }),
    );
    await sleep(10);
    expect(seen).toHaveLength(0); // never answered → no reply loop
    expect(errs.some((l) => l.includes("ignoring inbound"))).toBe(true);
  });

 it("client routes the null-id error response to diagnostics, not a request", async () => {
    const { port, client, diags } = connect();
    await client.start();
    // Garbage INTO the port → mock answers MALFORMED_MESSAGE with id:null
    // (the one sanctioned null-id response) → client logs it as a
    // diagnostic instead of resolving any request.
    port.writeLine("garbage{{{");
    await until(() => diags.some((l) => l.includes("null-id error response")));
    const pong = await client.ping("ok");
    expect(pong.echo).toBe("ok");
  });

  // #233: the terminate/restart fallback — the pieces the session
  // escalates to when graceful paths cannot reach the worker.
  it("shutdown() kills the worker when the graceful path times out", async () => {
    const { port, client } = connect();
    await client.start();
    let exitCode: number | null | undefined;
    port.onExit((c) => {
      exitCode = c;
    });
    port.simulateHang(); // wedged dispatch: no shutdown ack, no stdin EOF
    await client.shutdown(120);
    expect(client.getState()).toBe("closed");
    // The port really died — the process exited, not merely marked
    // closed on our side — so a respawn cannot hit
    // ENGINE_ALREADY_RUNNING.
    expect(exitCode).not.toBeUndefined();
  });

  it("terminate() kills immediately and rejects pending requests", async () => {
    const { port, client } = connect();
    await client.start();
    port.simulateHang(); // wedge first so the ping stays in flight
    const pending = client.ping("late").then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await client.terminate();
    expect(client.getState()).toBe("closed");
    await expect(pending).resolves.toMatch(/terminated|shut down|not ready/i);
  });
});
