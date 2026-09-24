/**
 * FEAT-001 (#60): 録音ポート。
 *
 * `CapturePort` は「録音デバイスのシーム」。ImportPorts と同じく、
 * コントローラはこのインターフェースだけに依存する。本番では
 * `runtimePorts.ts` が Tauri IPC(WASAPI)を選び、ブラウザ dev では
 * `getUserMedia`+`MediaRecorder` にフォールバックする。
 */
import type {
  CaptureDeviceList,
  CaptureResult,
  CaptureSessionInfo,
  CaptureSource,
  CaptureStatus,
} from "./types";

export interface CapturePort {
  /** 録音開始。すでに録音中なら拒否。`deviceId` は `listDevices` の
   *  id(省略時は既定デバイス)。`suggestedName` は保存ファイル名。 */
  start(
    source: CaptureSource,
    opts?: { deviceId?: string; suggestedName?: string },
  ): Promise<CaptureSessionInfo>;
  /** 録音停止して結果を返す(Tauri は保存パス、ブラウザは bytes)。 */
  stop(): Promise<CaptureResult>;
  /** 録音中止(データ破棄)。 */
  cancel(): Promise<void>;
  /** 録音の一時停止(#80)。対応していないポートは no-op でよい。 */
  pause?(): Promise<void>;
  /** 一時停止した録音の再開(#80)。 */
  resume?(): Promise<void>;
  /** 現在の録音状態。 */
  status(): Promise<CaptureStatus>;
  /** 取り込み可能なデバイス一覧(#73)。 */
  listDevices(): Promise<CaptureDeviceList>;
}
