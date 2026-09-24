/**
 * FEAT-001 (#60): 録音ポートの本番実装。
 *
 * - Tauri webview: `capture_start`/`capture_stop`/`capture_cancel`/
 *   `capture_status` の app-defined commands 経由(WASAPI)。
 * - ブラウザ dev: マイクのみ `getUserMedia` + `MediaRecorder` で録音し、
 *   WAV ではなくそのままデコード可能な Blob を返す。ループバックは
 *   WebView2/ブラウザの `getDisplayMedia` 非対応のため明示的に失敗する。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../tauri/bridge";
import type { CapturePort } from "./ports";
import type {
  CaptureDeviceList,
  CaptureResult,
  CaptureSessionInfo,
  CaptureSource,
  CaptureStatus,
} from "./types";

/* ------------------------------ Tauri port ------------------------------ */

interface RustSessionInfo {
  source: string;
  deviceName: string;
  sampleRate: number;
  channels: number;
}
interface RustCaptureResult {
  path: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  silentRatio: number;
  limitReached: boolean;
}
interface RustCaptureStatus {
  active: boolean;
  source: string | null;
  elapsedSeconds: number | null;
  deviceName: string | null;
  level: number | null;
  paused: boolean;
  error: string | null;
}
interface RustDevice {
  id: string;
  name: string;
  isDefault: boolean;
}
interface RustDeviceList {
  loopback: RustDevice[];
  microphone: RustDevice[];
}

function toSource(s: string): CaptureSource {
  return s === "loopback" ? "loopback" : "microphone";
}

class TauriCapturePort implements CapturePort {
  async start(
    source: CaptureSource,
    opts?: { deviceId?: string; suggestedName?: string },
  ): Promise<CaptureSessionInfo> {
    const info = await invoke<RustSessionInfo>("capture_start", {
      source,
      deviceId: opts?.deviceId ?? null,
      suggestedName: opts?.suggestedName ?? null,
    });
    return {
      source: toSource(info.source),
      deviceName: info.deviceName,
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
  }
  async stop(): Promise<CaptureResult> {
    const r = await invoke<RustCaptureResult>("capture_stop");
    return {
      path: r.path,
      durationSeconds: r.durationSeconds,
      sampleRate: r.sampleRate,
      channels: r.channels,
      silentRatio: r.silentRatio,
      limitReached: r.limitReached,
      mimeType: "audio/wav",
    };
  }
  async cancel(): Promise<void> {
    await invoke("capture_cancel");
  }
  async pause(): Promise<void> {
    await invoke("capture_pause");
  }
  async resume(): Promise<void> {
    await invoke("capture_resume");
  }
  async status(): Promise<CaptureStatus> {
    const s = await invoke<RustCaptureStatus>("capture_status");
    return {
      active: s.active,
      source: s.source ? toSource(s.source) : null,
      elapsedSeconds: s.elapsedSeconds,
      deviceName: s.deviceName,
      level: s.level ?? null,
      paused: s.paused,
      error: s.error,
    };
  }
  async listDevices(): Promise<CaptureDeviceList> {
    const d = await invoke<RustDeviceList>("capture_devices");
    return {
      loopback: d.loopback,
      microphone: d.microphone,
    };
  }
}

/* --------------------------- browser dev port --------------------------- */

/**
 * getUserMedia + MediaRecorder でマイクだけを録音する dev 用ポート。
 * システム音源はブラウザでは採れないため `loopback` は即座に失敗する
 * (unsupported)。録音物は webm/opus Blob のまま返し、decodeAudioData が
 * そのまま食べられる。
 */
class BrowserCapturePort implements CapturePort {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  /** #80: 一時停止の累積(経過時間から差し引く)。 */
  private pausedAt = 0;
  private pausedTotal = 0;
  private source: CaptureSource | null = null;
  // #71: ブラウザ dev のライブレベル用 AnalyserNode。
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private audioCtx: AudioContext | null = null;
  /** #79: MediaRecorder の致命的エラー — status() で UI に伝える。 */
  private lastError: string | null = null;

  async start(
    source: CaptureSource,
    opts?: { deviceId?: string; suggestedName?: string },
  ): Promise<CaptureSessionInfo> {
    if (source === "loopback") {
      throw new Error(
        "UNSUPPORTED: system-audio capture requires the desktop app",
      );
    }
    if (this.recorder) throw new Error("CAPTURE_BUSY");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts?.deviceId ? { exact: opts.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
    const rec = new MediaRecorder(stream);
    this.chunks = [];
    this.lastError = null;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onerror = (e) => {
      const err = (e as { error?: unknown }).error;
      this.lastError =
        err instanceof Error ? err.message : "MediaRecorder error";
    };
    this.recorder = rec;
    this.source = "microphone";
    this.startedAt = performance.now();
    this.pausedAt = 0;
    this.pausedTotal = 0;
    rec.start(250);
    // レベルメーター用の解析ノード(発音はしないので destination には繋がない)。
    try {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) {
        this.audioCtx = new Ctor();
        const src = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyserBuf = new Float32Array(this.analyser.fftSize);
        src.connect(this.analyser);
      }
    } catch {
      this.analyser = null;
    }
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    return {
      source: "microphone",
      deviceName: track?.label ?? "Microphone",
      sampleRate: settings.sampleRate ?? 48000,
      channels: settings.channelCount ?? 1,
    };
  }

  async stop(): Promise<CaptureResult> {
    const rec = this.recorder;
    if (!rec) throw new Error("CAPTURE_NOT_ACTIVE");
    const chunks = this.chunks;
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.onerror = () => resolve(); // エラーでも停止は完了させる
    });
    rec.stop();
    await stopped;
    rec.stream.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.teardownAnalyser();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const pausedSpan =
      this.pausedTotal +
      (this.pausedAt ? performance.now() - this.pausedAt : 0);
    const durationSeconds =
      (performance.now() - this.startedAt - pausedSpan) / 1000;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      bytes,
      durationSeconds,
      sampleRate: 48000,
      channels: 1,
      // MediaRecorder はエンコード済みなので無音率は不明。0 を返して
      // UI の「無音でした」ヒントには頼らない。
      silentRatio: 0,
      mimeType: blob.type || "audio/webm",
    };
  }

  async cancel(): Promise<void> {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) return;
    rec.ondataavailable = null;
    rec.onerror = null;
    rec.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    this.teardownAnalyser();
  }

  async pause(): Promise<void> {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.pause();
      this.pausedAt = performance.now();
    }
  }

  async resume(): Promise<void> {
    if (this.recorder && this.recorder.state === "paused") {
      this.recorder.resume();
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  async status(): Promise<CaptureStatus> {
    return this.recorder
      ? {
          active: true,
          source: this.source,
          elapsedSeconds:
            (performance.now() -
              this.startedAt -
              this.pausedTotal -
              (this.pausedAt ? performance.now() - this.pausedAt : 0)) /
            1000,
          deviceName: "Microphone",
          level: this.currentLevel(),
          paused: this.recorder.state === "paused",
          error: this.lastError,
        }
      : { active: false, source: null, elapsedSeconds: null, deviceName: null };
  }

  async listDevices(): Promise<CaptureDeviceList> {
    // ブラウザはマイクのみ。ラベルは権限取得後でないと空になることがある。
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      loopback: [],
      microphone: devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          id: d.deviceId,
          name: d.label || `マイク ${i + 1}`,
          isDefault: d.deviceId === "default",
        })),
    };
  }

  private currentLevel(): number | null {
    if (!this.analyser || !this.analyserBuf) return null;
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    let peak = 0;
    for (const v of this.analyserBuf) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return peak;
  }

  private teardownAnalyser(): void {
    this.analyser?.disconnect();
    this.analyser = null;
    this.analyserBuf = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}

export function createCapturePort(): CapturePort {
  return isTauriRuntime() ? new TauriCapturePort() : new BrowserCapturePort();
}
