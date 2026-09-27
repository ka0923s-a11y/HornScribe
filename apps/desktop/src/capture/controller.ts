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
  /** 一時停止中か(#80)。phase は "recording" のまま — 録音セッション
   *  は生きており、再開/停止/中止が選べる。 */
  readonly paused: boolean;
  /** #42: 録音前の入力レベルモニター。非 null なら選択デバイスの
   *  プレビューキャプチャ(書き出しなし)が動いている。idle 時のみ。 */
  readonly monitor: MonitorState | null;
}

export const INITIAL_CAPTURE_STATE: CaptureState = {
  phase: "idle",
  source: null,
  elapsedSeconds: 0,
  deviceName: null,
  issue: null,
  level: null,
  paused: false,
  monitor: null,
};

/** #42: 録音前モニターのスナップショット — 何のデバイスを
 *  どのくらいのレベルで聴いているか。 */
export interface MonitorState {
  readonly source: CaptureSource;
  readonly deviceId: string | null;
  readonly level: number | null;
}

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
  // #79: OS がデバイスアクセスを拒否(E_ACCESSDENIED 等)。
  if (
    msg.includes("E_ACCESSDENIED") ||
    msg.includes("0x80070005") ||
    msg.includes("NotAllowedError") ||
    msg.includes("NotAllowed")
  ) {
    return { kind: "permissionDenied", source };
  }
  // #79: 録音中のデバイス喪失(切断/独占奪取)。
  if (
    msg.includes("AUDCLNT_E_DEVICE_INVALIDATED") ||
    msg.includes("0x88890004") ||
    msg.includes("device invalidated") ||
    msg.includes("AbortError")
  ) {
    return { kind: "interrupted", source };
  }
  return { kind: "failed", detail: msg };
}

export class CaptureController {
  private state: CaptureState = INITIAL_CAPTURE_STATE;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** #42: モニター用ポーリング(録音タイマーとは別系統)。 */
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
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
    // #42: デバイスを選んだその場で入力レベルを確かめられるよう、
    // idle 時は選択をトリガにモニターを(再)開始する。録音中は触れない。
    if (this.state.phase === "idle") void this.startMonitor(source);
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
    // #42: モニターセッションは同じセッション枠を使うので、実録音の
    // 前に破棄する(cancel = temp無しの監視を閉じるだけ)。
    if (this.state.monitor) {
      this.stopMonitorTimer();
      try {
        await this.port.cancel();
      } catch {
        /* モニター掃除はベストエフォート — 録音開始を妨げない */
      }
    }
    this.setState({
      phase: "recording",
      source,
      elapsedSeconds: 0,
      deviceName: null,
      issue: null,
      level: null,
      paused: false,
      monitor: null,
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
        paused: false,
        monitor: null,
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
        paused: false,
        monitor: null,
      });
      this.events.announce(issueText(issue));
    }
  }

  /** 録音の一時停止(#80)。ポートが対応していなければ何もしない。 */
  async pause(): Promise<void> {
    if (this.state.phase !== "recording" || this.state.paused) return;
    if (!this.port.pause) return;
    try {
      await this.port.pause();
      this.setState({ ...this.state, paused: true, level: null });
      this.events.announce(
        "録音を一時停止しました。再開するまで音は記録されません。",
      );
    } catch (e) {
      const issue = classifyError(e, this.state.source ?? "microphone");
      this.setState({
        phase: "error",
        source: this.state.source,
        elapsedSeconds: 0,
        deviceName: null,
        issue,
        level: null,
        paused: false,
        monitor: null,
      });
      this.events.announce(issueText(issue));
    }
  }

  /** 一時停止した録音の再開(#80)。 */
  async resume(): Promise<void> {
    if (this.state.phase !== "recording" || !this.state.paused) return;
    if (!this.port.resume) return;
    try {
      await this.port.resume();
      this.setState({ ...this.state, paused: false });
      this.events.announce("録音を再開しました");
    } catch (e) {
      const issue = classifyError(e, this.state.source ?? "microphone");
      this.setState({
        phase: "error",
        source: this.state.source,
        elapsedSeconds: 0,
        deviceName: null,
        issue,
        level: null,
        paused: false,
        monitor: null,
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
        paused: false,
        monitor: null,
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
    this.stopMonitorTimer();
  }

  /* ---------------- #42: pre-record level monitor ---------------- */

  /** 選択デバイスの入力レベルを書き出し無しでライブ確認する。
   *  同時に1ソースのみ — 別ソースの開始は前のモニターを畳む。
   *  失敗は録音開始前の予行エラーとしてアナウンスする(デバイス不在/
   *  拒否をここで先に知れるのがこの機能の価値)。 */
  async startMonitor(source: CaptureSource): Promise<void> {
    if (this.state.phase !== "idle") return;
    const deviceId = this.deviceIds[source];
    if (
      this.state.monitor?.source === source &&
      this.state.monitor.deviceId === deviceId
    ) {
      return; // 同じモニターが既に走っている
    }
    this.stopMonitorTimer();
    try {
      await this.port.cancel(); // 別ソースのモニター残滓を畳む
    } catch {
      /* セッション無しなら何も起きない */
    }
    try {
      await this.port.start(source, {
        deviceId: deviceId ?? undefined,
        monitorOnly: true,
      });
      this.setState({
        ...this.state,
        monitor: { source, deviceId, level: null },
      });
      this.startMonitorTimer();
    } catch (e) {
      this.setState({ ...this.state, monitor: null });
      this.events.announce(issueText(classifyError(e, source)));
    }
  }

  /** モニターを畳む(メニューを閉じた時/録音前)。 */
  async stopMonitor(): Promise<void> {
    if (!this.state.monitor) return;
    this.stopMonitorTimer();
    try {
      await this.port.cancel();
    } catch {
      /* 掃除失敗は無視 — 表示だけ畳む */
    }
    this.setState({ ...this.state, monitor: null });
  }

  /** メニューの「入力レベル」行のトグル。 */
  async toggleMonitor(source: CaptureSource): Promise<void> {
    if (this.state.monitor?.source === source) {
      await this.stopMonitor();
      return;
    }
    await this.startMonitor(source);
  }

  private startMonitorTimer(): void {
    this.stopMonitorTimer();
    this.monitorTimer = setInterval(() => {
      const tick = async () => {
        const mon = this.state.monitor;
        if (!mon) {
          this.stopMonitorTimer();
          return;
        }
        try {
          const s = await this.port.status();
          // セッションが死んだ/モニターでなくなった → 表示だけ畳む。
          if (!s.active || !s.monitoring) {
            this.stopMonitorTimer();
            if (this.state.monitor) {
              this.setState({ ...this.state, monitor: null });
            }
            return;
          }
          // #79 と同じくワーカー側の致命的エラーを早めに拾う。
          if (s.error) {
            this.stopMonitorTimer();
            try {
              await this.port.cancel();
            } catch {
              /* 掃除失敗は無視 */
            }
            this.setState({ ...this.state, monitor: null });
            this.events.announce(
              issueText(classifyError(new Error(s.error), mon.source)),
            );
            return;
          }
          this.setState({
            ...this.state,
            monitor: { ...mon, level: s.level ?? null },
          });
        } catch {
          /* ポーリング失敗は次の tick に委ねる */
        }
      };
      void tick();
    }, 160);
  }

  private stopMonitorTimer(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
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
          // #79: ワーカー側の致命的エラー(デバイス切断等)を stop を
          // 待たずに拾う。エラー状態へ移してポート側を掃除する。
          if (s.error) {
            const issue = classifyError(
              new Error(s.error),
              this.state.source ?? "microphone",
            );
            this.stopTimer();
            try {
              await this.port.cancel();
            } catch {
              /* 掃除失敗は無視 — 状態は error に進む */
            }
            this.setState({
              phase: "error",
              source: this.state.source,
              elapsedSeconds: 0,
              deviceName: null,
              issue,
              level: null,
              paused: false,
              monitor: null,
            });
            this.events.announce(issueText(issue));
            return;
          }
          this.setState({
            ...this.state,
            elapsedSeconds:
              s.elapsedSeconds ?? (Date.now() - this.startedAtMs) / 1000,
            level: s.level ?? null,
            paused: s.paused ?? this.state.paused,
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
    case "permissionDenied":
      return issue.source === "loopback"
        ? "オーディオデバイスへのアクセスが許可されていません。デバイスの状態を確認してからもう一度お試しください。"
        : "マイクへのアクセスが許可されていません。Windowsの設定 → プライバシーとセキュリティ → マイク で、このアプリへのアクセスを許可してください。";
    case "interrupted":
      return issue.source === "loopback"
        ? "録音デバイスとの接続が切れました。再生デバイスの状態を確認して、録音をやり直してください。"
        : "マイクとの接続が切れました。マイクを接続し直して、録音をやり直してください。";
    case "failed":
      return `録音に失敗しました: ${issue.detail}`;
  }
}
