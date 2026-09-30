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

  it("#102: confirms before importing a near-silent take", async () => {
    const port = makePort({
      stop: vi.fn(async (): Promise<CaptureResult> => ({
        path: "C:\\rec\\quiet.wav",
        durationSeconds: 3,
        sampleRate: 48000,
        channels: 2,
        silentRatio: 0.98,
      })),
    });
    const { events, completed } = makeEvents();
    const confirmSilentImport = vi.fn(async () => true);
    const onCaptureDiscarded = vi.fn();
    const c = new CaptureController(port, {
      ...events,
      confirmSilentImport,
      onCaptureDiscarded,
    });
    await c.start("microphone");
    await c.stop();
    expect(confirmSilentImport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "microphone", silentRatio: 0.98 }),
    );
    expect(completed).toHaveLength(1);
    expect(onCaptureDiscarded).not.toHaveBeenCalled();
  });

  it("#102: discards a near-silent take when declined", async () => {
    const port = makePort({
      stop: vi.fn(async (): Promise<CaptureResult> => ({
        path: "C:\\rec\\quiet.wav",
        durationSeconds: 3,
        sampleRate: 48000,
        channels: 2,
        silentRatio: 0.97,
      })),
    });
    const { events, announced, completed } = makeEvents();
    const confirmSilentImport = vi.fn(async () => false);
    const onCaptureDiscarded = vi.fn();
    const c = new CaptureController(port, {
      ...events,
      confirmSilentImport,
      onCaptureDiscarded,
    });
    await c.start("loopback");
    await c.stop();
    expect(completed).toHaveLength(0);
    expect(onCaptureDiscarded).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "C:\\rec\\quiet.wav",
        source: "loopback",
      }),
    );
    expect(announced.at(-1)).toContain("破棄");
    expect(c.getState().phase).toBe("idle");
  });

  it("#102: imports a near-silent take without a confirm hook", async () => {
    const port = makePort({
      stop: vi.fn(async (): Promise<CaptureResult> => ({
        path: "C:\\rec\\quiet.wav",
        durationSeconds: 3,
        sampleRate: 48000,
        channels: 2,
        silentRatio: 0.99,
      })),
    });
    const { events, announced, completed } = makeEvents();
    const c = new CaptureController(port, events);
    await c.start("microphone");
    await c.stop();
    // 互換: 確認フックが無ければ従来どおり取り込み + 無音アナウンス。
    expect(completed).toHaveLength(1);
    expect(announced.at(-1)).toContain("無音");
  });

  it("#102: a failing confirm hook falls back to importing", async () => {
    const port = makePort({
      stop: vi.fn(async (): Promise<CaptureResult> => ({
        path: "C:\\rec\\quiet.wav",
        durationSeconds: 3,
        sampleRate: 48000,
        channels: 2,
        silentRatio: 0.99,
      })),
    });
    const { events, completed } = makeEvents();
    const c = new CaptureController(port, {
      ...events,
      confirmSilentImport: vi.fn(async () => {
        throw new Error("ui gone");
      }),
    });
    await c.start("microphone");
    await c.stop();
    expect(completed).toHaveLength(1);
  });

  it("#99: count-in delays the port start and counts down", async () => {
    vi.useFakeTimers();
    try {
      const port = makePort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      c.setCountInSeconds(3);
      const started = c.start("microphone");
      expect(port.start).not.toHaveBeenCalled();
      expect(c.getState().countInRemaining).toBe(3);
      await vi.advanceTimersByTimeAsync(3000);
      await started;
      expect(port.start).toHaveBeenCalledTimes(1);
      expect(c.getState().phase).toBe("recording");
      // 録音中はカウント終了 — フィールドは未設定(undefined/null 同等)。
      expect(c.getState().countInRemaining ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#99: cancelling during count-in prevents the session", async () => {
    vi.useFakeTimers();
    try {
      const port = makePort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      c.setCountInSeconds(5);
      const started = c.start("microphone");
      await vi.advanceTimersByTimeAsync(1000);
      expect(c.getState().countInRemaining).toBe(4);
      await c.cancel();
      await vi.advanceTimersByTimeAsync(10000);
      await started;
      expect(port.start).not.toHaveBeenCalled();
      expect(c.getState().phase).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#105: accumulates live waveform peaks from status ticks", async () => {
    vi.useFakeTimers();
    try {
      let total = 4;
      const port = makePort({
        status: vi.fn(async (): Promise<CaptureStatus> => ({
          active: true,
          source: "microphone",
          elapsedSeconds: 1,
          deviceName: "dev",
          waveformTotal: total,
          waveformPeaks: [0.1, 0.5, 0.2, 0.4, 0.7, 0.9].slice(
            Math.max(0, total - 6),
            total,
          ),
        })),
      });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      await c.start("microphone");
      await vi.advanceTimersByTimeAsync(250);
      expect(c.getState().takePeaks).toEqual([0.1, 0.5, 0.2, 0.4]);
      // 2 ピーク増えた次の tick は差分だけ追記する。
      total = 6;
      await vi.advanceTimersByTimeAsync(250);
      expect(c.getState().takePeaks).toEqual(
        [0.1, 0.5, 0.2, 0.4, 0.7, 0.9],
      );
      // 同一 total の再ポーリングは重複しない。
      await vi.advanceTimersByTimeAsync(250);
      expect(c.getState().takePeaks).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
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

  describe("level monitor (#42)", () => {
    /** モニターセッションを模倣するポート — monitorOnly で開いた
     *  セッションだけが monitoring: true を返す。 */
    function monitorPort(level = 0.5) {
      let monitoring = false;
      const port = makePort({
        start: vi.fn(
          async (
            source,
            opts,
          ): Promise<CaptureSessionInfo> => {
            if (opts?.monitorOnly) monitoring = true;
            return {
              source,
              deviceName: "dev",
              sampleRate: 48000,
              channels: 2,
            };
          },
        ),
        cancel: vi.fn(async () => {
          monitoring = false;
        }),
        status: vi.fn(async (): Promise<CaptureStatus> => ({
          active: monitoring,
          source: monitoring ? "microphone" : null,
          elapsedSeconds: monitoring ? 1 : null,
          deviceName: monitoring ? "dev" : null,
          level: monitoring ? level : null,
          monitoring,
        })),
      });
      return port;
    }

    it("startMonitor opens a write-less session and polls the level",
      async () => {
        vi.useFakeTimers();
        try {
          const port = monitorPort(0.6);
          const { events } = makeEvents();
          const c = new CaptureController(port, events);
          await c.startMonitor("microphone");
          expect(port.start).toHaveBeenCalledWith(
            "microphone",
            expect.objectContaining({ monitorOnly: true }),
          );
          expect(c.getState().monitor?.source).toBe("microphone");
          await vi.advanceTimersByTimeAsync(200);
          expect(c.getState().monitor?.level).toBe(0.6);
          c.dispose();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("stopMonitor cancels the session and clears the state", async () => {
      const port = monitorPort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      await c.startMonitor("microphone");
      await c.stopMonitor();
      expect(port.cancel).toHaveBeenCalled();
      expect(c.getState().monitor).toBeNull();
    });

    it("toggleMonitor starts and stops the same source", async () => {
      const port = monitorPort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      await c.toggleMonitor("loopback");
      expect(c.getState().monitor?.source).toBe("loopback");
      await c.toggleMonitor("loopback");
      expect(c.getState().monitor).toBeNull();
    });

    it("selectDevice starts a monitor for the picked source", async () => {
      const port = monitorPort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      c.selectDevice("microphone", "dev-42");
      await vi.waitFor(() => {
        expect(c.getState().monitor?.source).toBe("microphone");
      });
      expect(c.getState().monitor?.deviceId).toBe("dev-42");
      expect(port.start).toHaveBeenCalledWith(
        "microphone",
        expect.objectContaining({ deviceId: "dev-42", monitorOnly: true }),
      );
    });

    it("recording cancels the monitor session first", async () => {
      const port = monitorPort();
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      await c.startMonitor("microphone");
      await c.start("microphone");
      expect(port.cancel).toHaveBeenCalled();
      expect(c.getState().monitor).toBeNull();
      expect(c.getState().phase).toBe("recording");
      // 2回目の start が録音用(monitorOnly 無し)であること。
      const calls = (port.start as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).not.toHaveProperty("monitorOnly");
    });

    it("a failed monitor start announces the pre-flight issue", async () => {
      const port = monitorPort();
      port.start = vi.fn(async () => {
        throw new Error("マイクが見つかりません");
      });
      const { events, announced } = makeEvents();
      const c = new CaptureController(port, events);
      await c.startMonitor("microphone");
      expect(c.getState().monitor).toBeNull();
      expect(announced.at(-1)).toContain("マイク");
    });

    it("a dead monitor session clears itself on the next poll",
      async () => {
        vi.useFakeTimers();
        try {
          const port = monitorPort();
          // status() が非モニター(セッション死亡)を返すケース。
          port.status = vi.fn(async (): Promise<CaptureStatus> => ({
            active: false,
            source: null,
            elapsedSeconds: null,
            deviceName: null,
          }));
          const { events } = makeEvents();
          const c = new CaptureController(port, events);
          await c.startMonitor("microphone");
          expect(c.getState().monitor).not.toBeNull();
          await vi.advanceTimersByTimeAsync(200);
          expect(c.getState().monitor).toBeNull();
          c.dispose();
        } finally {
          vi.useRealTimers();
        }
      },
    );
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

describe("starting phase (pre-session)", () => {
  /** Promise 制御で port.start() の応答を遅らせる — getUserMedia の
   *  許可待ちや遅いドライバ応答を再現する。 */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const p = new Promise<T>((res) => {
      resolve = res;
    });
    return { p, resolve };
  }

  const info: CaptureSessionInfo = {
    source: "microphone",
    deviceName: "dev",
    sampleRate: 48000,
    channels: 2,
  };

  it("reports 'starting', not 'recording', until the device opens",
    async () => {
      const d = deferred<CaptureSessionInfo>();
      const port = makePort({ start: vi.fn(() => d.p) });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      const pending = c.start("microphone");
      expect(c.getState().phase).toBe("starting");
      d.resolve(info);
      await pending;
      expect(c.getState().phase).toBe("recording");
    },
  );

  it("pause/resume are inert during starting (no phantom pause)",
    async () => {
      const d = deferred<CaptureSessionInfo>();
      const port = makePort({
        start: vi.fn(() => d.p),
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      const pending = c.start("microphone");
      await c.pause();
      expect(c.getState().paused).toBe(false);
      expect(port.pause).not.toHaveBeenCalled();
      await c.resume();
      expect(port.resume).not.toHaveBeenCalled();
      d.resolve(info);
      await pending;
      expect(c.getState().phase).toBe("recording");
    },
  );

  it("cancel during starting still closes a late-opened session",
    async () => {
      const d = deferred<CaptureSessionInfo>();
      const port = makePort({ start: vi.fn(() => d.p) });
      const { events, completed } = makeEvents();
      const c = new CaptureController(port, events);
      const pending = c.start("microphone");
      await c.cancel();
      expect(c.getState().phase).toBe("idle");
      // The device opens after the user already left — the session
      // must be closed, not left recording with nobody watching.
      d.resolve(info);
      await pending;
      expect(port.cancel).toHaveBeenCalledTimes(2);
      expect(c.getState().phase).toBe("idle");
      expect(completed).toHaveLength(0);
    },
  );

  it("stop during starting is cancel (nothing to import yet)",
    async () => {
      const d = deferred<CaptureSessionInfo>();
      const port = makePort({ start: vi.fn(() => d.p) });
      const { events, completed } = makeEvents();
      const c = new CaptureController(port, events);
      const pending = c.start("microphone");
      await c.stop();
      expect(c.getState().phase).toBe("idle");
      d.resolve(info);
      await pending;
      expect(port.cancel).toHaveBeenCalledTimes(2);
      expect(completed).toHaveLength(0);
    },
  );

  it("a second start during starting is refused", async () => {
    const d = deferred<CaptureSessionInfo>();
    const port = makePort({ start: vi.fn(() => d.p) });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    const pending = c.start("microphone");
    await c.start("loopback"); // inert — already starting
    expect(port.start).toHaveBeenCalledTimes(1);
    d.resolve(info);
    await pending;
    expect(c.getState().phase).toBe("recording");
    expect(c.getState().source).toBe("microphone");
  });

  it("dispose during starting marks idle so a late session is cleaned",
    async () => {
      const d = deferred<CaptureSessionInfo>();
      const port = makePort({ start: vi.fn(() => d.p) });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      const pending = c.start("microphone");
      c.dispose();
      d.resolve(info);
      await pending;
      expect(port.cancel).toHaveBeenCalled();
      expect(c.getState().phase).toBe("idle");
    },
  );

  it("#100: forwards the selected app's pid for loopback capture", async () => {
    const port = makePort({
      listAudioSessions: vi.fn(async () => [
        { pid: 4242, name: "music.exe", active: true },
        { pid: 1111, name: "other.exe", active: false },
      ]),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    c.selectTargetApp({ pid: 4242, name: "music.exe", active: true });
    await c.start("loopback");
    expect(port.start).toHaveBeenCalledWith(
      "loopback",
      expect.objectContaining({ targetPid: 4242 }),
    );
  });

  it("#100: re-resolves a stale pid by app name", async () => {
    // アプリ再起動で pid が変わった — 名前一致で新しい pid を拾う。
    const port = makePort({
      listAudioSessions: vi.fn(async () => [
        { pid: 9000, name: "music.exe", active: true },
      ]),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
    c.selectTargetApp({ pid: 4242, name: "music.exe", active: true });
    await c.start("loopback");
    expect(port.start).toHaveBeenCalledWith(
      "loopback",
      expect.objectContaining({ targetPid: 9000 }),
    );
  });

  it("#100: falls back to the whole mix when the app has no session",
    async () => {
      const port = makePort({
        listAudioSessions: vi.fn(async () => []),
      });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      c.selectTargetApp({ pid: 4242, name: "gone.exe", active: true });
      await c.start("loopback");
      const opts = vi.mocked(port.start).mock.calls[0]?.[1];
      expect(opts?.targetPid).toBeUndefined();
    },
  );

  it("#100: selecting null returns to whole-mix capture", async () => {
    const port = makePort({
      listAudioSessions: vi.fn(async () => [
        { pid: 4242, name: "music.exe", active: true },
      ]),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
   c.selectTargetApp({ pid: 4242, name: "music.exe", active: true });
   c.selectTargetApp(null);
   await c.start("loopback");
    const opts = vi.mocked(port.start).mock.calls[0]?.[1];
    expect(opts?.targetPid).toBeUndefined();
  });

  it("#100: microphone capture never carries a target pid", async () => {
    const port = makePort({
      listAudioSessions: vi.fn(async () => [
        { pid: 4242, name: "music.exe", active: true },
      ]),
    });
    const { events } = makeEvents();
    const c = new CaptureController(port, events);
   c.selectTargetApp({ pid: 4242, name: "music.exe", active: true });
   await c.start("microphone");
    const opts = vi.mocked(port.start).mock.calls[0]?.[1];
    expect(opts?.targetPid).toBeUndefined();
  });

  it("#138: changing the target app restarts a running loopback monitor",
    async () => {
      const port = makePort({
        listAudioSessions: vi.fn(async () => [
          { pid: 4242, name: "music.exe", active: true },
          { pid: 7777, name: "game.exe", active: true },
        ]),
      });
      const { events } = makeEvents();
      const c = new CaptureController(port, events);
      c.selectTargetApp({ pid: 4242, name: "music.exe", active: true });
      await c.startMonitor("loopback");
      expect(c.getState().monitor?.source).toBe("loopback");
      expect(vi.mocked(port.start).mock.calls.at(-1)?.[1]?.targetPid)
        .toBe(4242);
      // モニター中に対象を変える → 新しい pid でモニターを張り直す。
      c.selectTargetApp({ pid: 7777, name: "game.exe", active: true });
      await vi.waitFor(() => {
        expect(vi.mocked(port.start).mock.calls.at(-1)?.[1]?.targetPid)
          .toBe(7777);
      });
    },
  );
});
