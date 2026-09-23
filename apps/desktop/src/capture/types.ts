/**
 * FEAT-001 (#60): 録音取り込みの型。
 *
 * 「PCの音を取り込む」(WASAPI ループバック)と「マイクで録音」の
 * 2 ソースを一つの `CaptureSource` にまとめる。UI はソース名を見て
 * コピーを切り替える。
 */

export type CaptureSource = "loopback" | "microphone";

/** 録音開始直後のセッション情報(Rust `CaptureSessionInfo` に対応)。 */
export interface CaptureSessionInfo {
  source: CaptureSource;
  /** デバイス表示名(診断・ステータス用。通常UIの本文には出さない)。 */
  deviceName: string;
  sampleRate: number;
  channels: number;
}

/** 録音完了時の結果(Rust `CaptureResult` に対応)。 */
export interface CaptureResult {
  /** Tauri: 保存先 WAV の絶対パス(appDataDir/recordings/)。
   *  実ファイルにすることでプロジェクトの sourceAudio に乗る(#70)。 */
  path?: string;
  /** ブラウザ dev: 録音バイト列(path が無い環境用)。 */
  bytes?: Uint8Array;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** 0.0–1.0。ほぼ無音だった時に「無音でした」を出すためのヒント。 */
  silentRatio: number;
  /** 30分の連続録音上限で自動停止したか。 */
  limitReached?: boolean;
  /** コンテナの MIME(省略時は audio/wav)。ブラウザ dev では
   *  MediaRecorder 出力(webm 等)が入るため、表示名の拡張子に使う。 */
  mimeType?: string;
}

/** 録音状態のスナップショット。 */
export interface CaptureStatus {
  active: boolean;
  source: CaptureSource | null;
  elapsedSeconds: number | null;
  deviceName: string | null;
  /** 直近の入力ピーク(0.0–1.0)。レベルメーター用(#71)。 */
  level?: number | null;
}

/** 録音デバイス1台(#73)。 */
export interface CaptureDevice {
  /** WASAPI エンドポイント ID またはブラウザの deviceId。 */
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CaptureDeviceList {
  loopback: CaptureDevice[];
  microphone: CaptureDevice[];
}

/** UI 表示用のエラー分類。Rust のエラーコードをここで正規化する。 */
export type CaptureIssue =
  /** 対応デバイスが無い(マイク無し/ループバック非対応等)。 */
  | { kind: "noDevice"; source: CaptureSource }
  /** 別の録音が走っている。 */
  | { kind: "busy" }
  /** 録音がアクティブでないのに stop/cancel を呼んだ。 */
  | { kind: "notActive" }
  /** 環境が未対応(Tauri ではないブラウザで loopback を要求した等)。 */
  | { kind: "unsupported"; source: CaptureSource }
  /** キャプチャスレッド側の致命的失敗。 */
  | { kind: "failed"; detail: string };
