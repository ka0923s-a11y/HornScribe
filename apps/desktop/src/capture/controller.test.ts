import { describe, expect, it, vi } from "vitest";
import { CaptureController, issueText } from "./controller";
import type { CapturePort } from "./ports";
import type {
  CaptureResult,
  CaptureSessionInfo,
  CaptureStatus,
} from "./types";

function makePort(overrides: Partial<CapturePort> = {}): CapturePort {
  return {
    start: vi.fn(async (source): Promise<CaptureSessionInfo> => ({
      source,
      deviceName: "dev",
      sampleRate: 48000,
      channels: 2,
    })),
    stop: vi.fn(async (): Promise<CaptureResult> => ({
      bytes: new Uint8Array([82, 73, 70, 70]),
      durationSeconds: 1.5,
      sampleRate: 48000,
      channels: 2,
      silentRatio: 0,
    })),
    cancel: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<CaptureStatus> => ({
      active: false,
      source: null,
      elapsedSeconds: null,
      deviceName: null,
    })),
    listDevices: vi.fn(async () => ({ loopback: [], microphone: [] })),
    ...overrides,
  };
}

function makeEvents() {
  const states: unknown[] = [];
  const announced: string[] = [];
  const completed: Array<{ fileName: string; source: string }> = [];
  return {
    states,
    announced,
    completed,
    events: {
      onState: (s: never) => states.push(s),
      announce: (m: string) => announced.push(m),
      onCaptureComplete: (r: { fileName: string; source: string }) =>
        completed.push(r),
    },
  };
}

describe("CaptureController", () => {
  it("starts recording and reports state", async () => {
    const port = makePort();
    const { events, states } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    expect(port.start).toHaveBeenCalledWith(
      "microphone",
      expect.objectContaining({
        suggestedName: expect.stringMatching(/\.wav$/),
      }),
    );
    const last = states.at(-1) as { phase: string };
    expect(last.phase).toBe("recording");
  });

  it("stops and forwards the recorded bytes", async () => {
    const port = makePort();
    const { events, completed } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    await c.stop();
    expect(port.stop).toHaveBeenCalled();
    expect(completed).toHaveLength(1);
    expect(completed[0].source).toBe("microphone");
    expect(completed[0].fileName).toMatch(/\.wav$/);
    // state is back to idle
    expect(c.getState().phase).toBe("idle");
  });

  it("cancel discards without completing", async () => {
    const port = makePort();
    const { events, completed } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("loopback");
    await c.cancel();
    expect(port.cancel).toHaveBeenCalled();
    expect(completed).toHaveLength(0);
    expect(c.getState().phase).toBe("idle");
  });

  it("maps start failure to a typed issue", async () => {
    const port = makePort({
      start: vi.fn(async () => {
        throw new Error("既定のマイクが見つかりません");
      }),
    });
    const { events, announced } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    expect(c.getState().phase).toBe("error");
    expect(c.getState().issue?.kind).toBe("noDevice");
    expect(announced.at(-1)).toContain("マイク");
  });

  it("rejects loopback in a browser port as unsupported", async () => {
    const port = makePort({
      start: vi.fn(async () => {
        throw new Error("UNSUPPORTED: system-audio capture requires the desktop app");
      }),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("loopback");
    expect(c.getState().issue?.kind).toBe("unsupported");
  });

  it("double-start while recording is a no-op", async () => {
    const port = makePort();
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    await c.start("loopback");
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it("issueText produces Japanese recovery guidance", () => {
    expect(issueText({ kind: "noDevice", source: "microphone" })).toContain(
      "マイク",
    );
    expect(issueText({ kind: "noDevice", source: "loopback" })).toContain(
      "再生デバイス",
    );
    expect(issueText({ kind: "unsupported", source: "loopback" })).toContain(
      "デスクトップアプリ",
    );
  });

  it("forwards a selected device id to the port (#73)", async () => {
    const port = makePort();
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    c.selectDevice("microphone", "dev-42");
    await c.start("microphone");
    expect(port.start).toHaveBeenCalledWith(
      "microphone",
      expect.objectContaining({ deviceId: "dev-42" }),
    );
  });

  it("forwards the saved path on stop (#70)", async () => {
    const port = makePort({
      stop: vi.fn(async (): Promise<CaptureResult> => ({
        path: "C:\\rec\\take.wav",
        durationSeconds: 2,
        sampleRate: 48000,
        channels: 2,
        silentRatio: 0,
      })),
    });
    const { events, completed } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("loopback");
    await c.stop();
    expect((completed[0] as { path?: string }).path).toBe(
      "C:\\rec\\take.wav",
    );
  });

  it("pauses and resumes via the port (#80)", async () => {
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    const port = makePort({ pause, resume });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    await c.pause();
    expect(pause).toHaveBeenCalled();
    expect(c.getState().paused).toBe(true);
    // phase stays "recording" — the session is alive.
    expect(c.getState().phase).toBe("recording");
    await c.resume();
    expect(resume).toHaveBeenCalled();
    expect(c.getState().paused).toBe(false);
  });

  it("pause is a no-op for ports without pause support", async () => {
    const port = makePort(); // no pause/resume methods
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    await c.pause();
    expect(c.getState().paused).toBe(false);
  });

  it("maps E_ACCESSDENIED to permissionDenied (#79)", async () => {
    const port = makePort({
      start: vi.fn(async () => {
        throw new Error("IAudioClient::Initialize: HRESULT 0x80070005");
      }),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    expect(c.getState().issue?.kind).toBe("permissionDenied");
  });

  it("maps device invalidation to interrupted (#79)", async () => {
    const port = makePort({
      start: vi.fn(async () => {
        throw new Error("GetBuffer: HRESULT 0x88890004");
      }),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("loopback");
    expect(c.getState().issue?.kind).toBe("interrupted");
  });

  it("surfaces a worker error from status polling (#79)", async () => {
    vi.useFakeTimers();
    try {
      const port = makePort({
        status: vi.fn(async (): Promise<CaptureStatus> => ({
          active: true,
          source: "microphone",
          elapsedSeconds: 1,
          deviceName: "dev",
          error: "GetBuffer: HRESULT 0x88890004",
        })),
      });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      await c.start("microphone");
      // The 200 ms status poll picks the worker error up.
      await vi.advanceTimersByTimeAsync(300);
      expect(c.getState().phase).toBe("error");
      expect(c.getState().issue?.kind).toBe("interrupted");
      expect(port.cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
