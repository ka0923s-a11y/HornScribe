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
  async status(): Promise<CaptureStatus> {
    const s = await invoke<RustCaptureStatus>("capture_status");
    return {
      active: s.active,
      source: s.source ? toSource(s.source) : null,
      elapsedSeconds: s.elapsedSeconds,
      deviceName: s.deviceName,
      level: s.level ?? null,
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
  private source: CaptureSource | null = null;
  // #71: ブラウザ dev のライブレベル用 AnalyserNode。
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private audioCtx: AudioContext | null = null;

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
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder = rec;
    this.source = "microphone";
    this.startedAt = performance.now();
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
    });
    rec.stop();
    await stopped;
    rec.stream.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.teardownAnalyser();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const durationSeconds = (performance.now() - this.startedAt) / 1000;
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
    rec.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    this.teardownAnalyser();
  }

  async status(): Promise<CaptureStatus> {
    return this.recorder
      ? {
          active: true,
          source: this.source,
          elapsedSeconds: (performance.now() - this.startedAt) / 1000,
          deviceName: "Microphone",
          level: this.currentLevel(),
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
