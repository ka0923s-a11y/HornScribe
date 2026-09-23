/**
 * FEAT-001 (#60): 録音コントローラ。
 *
 * ImportController と同じく framework-free。App が subscribe して
 * 状態を反映する。録音は 1 本だけ(ポート側で BUSY を返す)。
 *
 * 状態遷移:
 *   idle ─start→ recording ─stop→ importing ─ok→ (ImportController 経由で
 *                                                AUDIO_READY に着地)
 *                  │                  └─ 失敗 → error (録音失敗)
 *                  └─ cancel → idle
 */
import type { CapturePort } from "./ports";
import type {
  CaptureDeviceList,
  CaptureIssue,
  CaptureSource,
  CaptureStatus,
} from "./types";

export type CapturePhase = "idle" | "recording" | "importing" | "error";

export interface CaptureState {
  readonly phase: CapturePhase;
  readonly source: CaptureSource | null;
  readonly elapsedSeconds: number;
  readonly deviceName: string | null;
  readonly issue: CaptureIssue | null;
  /** 録音中の入力レベル(0.0–1.0)。#71 の簡易メーター。 */
  readonly level: number | null;
}

export const INITIAL_CAPTURE_STATE: CaptureState = {
  phase: "idle",
  source: null,
  elapsedSeconds: 0,
  deviceName: null,
  issue: null,
  level: null,
};

export interface CaptureEvents {
  onState(state: CaptureState): void;
  announce(message: string): void;
  /**
   * 録音データをインポートへ橋渡しする(WAV bytes → LoadedAudio)。
   * App が ImportController と繋ぐ。
   */
  onCaptureComplete(result: {
    /** Tauri: 保存済み WAV のパス。ブラウザ dev: 録音バイト列。 */
    path?: string;
    bytes?: Uint8Array;
    fileName: string;
    source: CaptureSource;
    durationSeconds: number;
    silentRatio: number;
    mimeType?: string;
  }): void;
}

/** デバイス選択の保存キー(localStorage)。#73。 */
const DEVICE_PREF_KEY = "hornscribe.capture.deviceId";

/** Rust のエラー文字列を分類する。 */
function classifyError(err: unknown, source: CaptureSource): CaptureIssue {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("UNSUPPORTED")) {
    return { kind: "unsupported", source };
  }
  if (msg.includes("CAPTURE_BUSY")) return { kind: "busy" };
  if (msg.includes("CAPTURE_NOT_ACTIVE")) return { kind: "notActive" };
  if (
    msg.includes("再生デバイスが見つかりません") ||
    msg.includes("マイクが見つかりません") ||
    msg.includes("NotFound") ||
    msg.includes("0x80070490") // ERROR_NOT_FOUND
  ) {
    return { kind: "noDevice", source };
  }
  return { kind: "failed", detail: msg };
}

export class CaptureController {
  private state: CaptureState = INITIAL_CAPTURE_STATE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  /** start 時に決めた保存/表示ファイル名(stop で使い回す)。 */
  private pendingFileName: string | null = null;
  /** ソース別の選択デバイス ID(#73)。null = 既定。 */
  private deviceIds: Record<CaptureSource, string | null> = {
    loopback: null,
    microphone: null,
  };

  constructor(
    private readonly port: CapturePort,
    private readonly events: CaptureEvents,
  ) {
    try {
      const saved = globalThis.localStorage?.getItem(DEVICE_PREF_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<
          Record<CaptureSource, string | null>
        >;
        this.deviceIds.loopback = parsed.loopback ?? null;
        this.deviceIds.microphone = parsed.microphone ?? null;
      }
    } catch {
      /* storage が使えない環境では既定デバイスのまま */
    }
  }

  /** 選択中のデバイス ID(null = 既定)。 */
  selectedDeviceId(source: CaptureSource): string | null {
    return this.deviceIds[source];
  }

  /** デバイス選択を更新して保持する。null で既定に戻す。 */
  selectDevice(source: CaptureSource, deviceId: string | null): void {
    this.deviceIds[source] = deviceId;
    try {
      globalThis.localStorage?.setItem(
        DEVICE_PREF_KEY,
        JSON.stringify(this.deviceIds),
      );
    } catch {
      /* storage 不可は無視 */
    }
  }

  /** デバイス一覧(#73)。失敗は空リストに畳む(メニューが死なないよう)。 */
  async listDevices(): Promise<CaptureDeviceList> {
    try {
      return await this.port.listDevices();
    } catch {
      return { loopback: [], microphone: [] };
    }
  }

  getState(): CaptureState {
    return this.state;
  }

  /** 録音開始。`source` は "loopback" | "microphone"。 */
  async start(source: CaptureSource): Promise<void> {
    if (this.state.phase === "recording" || this.state.phase === "importing") {
      return;
    }
    this.setState({
      phase: "recording",
      source,
      elapsedSeconds: 0,
      deviceName: null,
      issue: null,
      level: null,
    });
    try {
      const fileName = source === "loopback"
        ? `PCの音_${timestampForFile()}.wav`
        : `録音_${timestampForFile()}.wav`;
      const info = await this.port.start(source, {
        deviceId: this.deviceIds[source] ?? undefined,
        suggestedName: fileName,
      });
      this.setState({
        phase: "recording",
        source,
        elapsedSeconds: 0,
        deviceName: info.deviceName,
        issue: null,
        level: null,
      });
      this.pendingFileName = fileName;
      this.startedAtMs = Date.now();
      this.events.announce(
        source === "loopback"
          ? "PCの音を取り込んでいます"
          : "マイクで録音しています",
      );
      this.startTimer();
    } catch (e) {
      const issue = classifyError(e, source);
      this.setState({
        phase: "error",
        source,
        elapsedSeconds: 0,
        deviceName: null,
        issue,
        level: null,
      });
      this.events.announce(issueText(issue));
    }
  }

  /** 録音停止 → WAV 化 → onCaptureComplete へ。 */
  async stop(): Promise<void> {
    if (this.state.phase !== "recording") return;
    const source = this.state.source ?? "microphone";
    this.setState({ ...this.state, phase: "importing" });
    this.stopTimer();
    try {
      const result = await this.port.stop();
      // 拡張子は実際のコンテナに合わせる(ブラウザ dev は webm 等)。
      const ext = (result.mimeType ?? "audio/wav").includes("webm")
        ? "webm"
        : "wav";
      const fileName = this.pendingFileName
        ? this.pendingFileName.replace(/\.wav$/, `.${ext}`)
        : source === "loopback"
          ? `PCの音_${timestampForFile()}.${ext}`
          : `録音_${timestampForFile()}.${ext}`;
      this.pendingFileName = null;
      this.setState({ ...INITIAL_CAPTURE_STATE });
      this.events.onCaptureComplete({
        path: result.path,
        bytes: result.bytes,
        fileName,
        source,
        durationSeconds: result.durationSeconds,
        silentRatio: result.silentRatio,
        mimeType: result.mimeType,
      });
      // ほぼ無音の録音は取り込み後に一言添える(ブラウザ dev ポートは
      // silentRatio=0 を返すので Tauri 経路でのみ発火する)。
      if (result.silentRatio >= 0.95) {
        this.events.announce(
          "録音はほぼ無音でした。音が再生されているか、マイクが接続されているか確認してください。",
        );
      }
      if (result.limitReached) {
        this.events.announce(
          "連続録音の上限(30分)に達したため、録音を終了しました。",
        );
      }
    } catch (e) {
      const issue = classifyError(e, this.state.source ?? "microphone");
      this.setState({
        phase: "error",
        source: this.state.source,
        elapsedSeconds: 0,
        deviceName: null,
        issue,
        level: null,
      });
      this.events.announce(issueText(issue));
    }
  }

  /** 録音中止(破棄)。 */
  async cancel(): Promise<void> {
    if (this.state.phase !== "recording") return;
    this.stopTimer();
    try {
      await this.port.cancel();
    } catch {
      /* キャンセル自体の失敗は無視 — 状態は idle に戻す */
    }
    this.setState({ ...INITIAL_CAPTURE_STATE });
    this.events.announce("録音を取りやめました");
  }

  /** 外部からの状態問い合わせ(ボタン活性など)。 */
  async refreshStatus(): Promise<CaptureStatus> {
    return this.port.status();
  }

  dispose(): void {
    this.stopTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.state.phase !== "recording") {
        this.stopTimer();
        return;
      }
      const tick = async () => {
        // レベルはポートから取る(#71)。経過時間はポートの frames ベースが
        // 正確だが、取れない場合はローカル時計で進める。
        try {
          const s = await this.port.status();
          if (this.state.phase !== "recording") return;
          this.setState({
            ...this.state,
            elapsedSeconds:
              s.elapsedSeconds ?? (Date.now() - this.startedAtMs) / 1000,
            level: s.level ?? null,
          });
        } catch {
          this.setState({
            ...this.state,
            elapsedSeconds: (Date.now() - this.startedAtMs) / 1000,
          });
        }
      };
      void tick();
    }, 200);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setState(next: CaptureState): void {
    this.state = next;
    this.events.onState(next);
  }
}

function timestampForFile(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** CaptureIssue → 日本語メッセージ(ステータス行 / アナウンス用)。 */
export function issueText(issue: CaptureIssue): string {
  switch (issue.kind) {
    case "noDevice":
      return issue.source === "loopback"
        ? "既定の再生デバイスが見つかりません。PCで音を再生してからもう一度お試しください。"
        : "マイクが見つかりません。マイクを接続してからもう一度お試しください。";
    case "busy":
      return "別の録音が進行中です。";
    case "notActive":
      return "録音が開始されていません。";
    case "unsupported":
      return issue.source === "loopback"
        ? "PCの音の取り込みはデスクトップアプリでのみ利用できます。"
        : "この環境では録音を利用できません。";
    case "failed":
      return `録音に失敗しました: ${issue.detail}`;
  }
}
