/**
 * 録音ファイル管理 (#78) — appDataDir/recordings/ の確認・開く・全削除。
 *
 * Tauri 専用: ブラウザ dev には実フォルダが無いので全て null/no-op を
 * 返す。コマンドは app-defined なので ACL 不要(engine/capture と同じ
 * 自己制限パターン: Rust 側が対象を recordings/*.wav に限定する)。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../tauri/bridge";

export interface RecordingsInfo {
  /** 保存先フォルダの絶対パス。 */
  dir: string;
  /** 保存済み WAV の件数。 */
  fileCount: number;
  /** 合計バイト数。 */
  totalBytes: number;
}

/** 録音フォルダの情報。Tauri 以外/失敗時は null。 */
export async function getRecordingsInfo(): Promise<RecordingsInfo | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<RecordingsInfo>("recordings_info");
  } catch {
    return null;
  }
}

/** 録音フォルダをエクスプローラーで開く。成功時 true。 */
export async function openRecordingsDir(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("open_recordings_dir");
    return true;
  } catch {
    return false;
  }
}

/** 録音 WAV を全削除し、解放バイト数を返す。失敗時 null。
 *  録音中は Rust 側が CAPTURE_BUSY で拒否する。 */
export async function clearRecordings(): Promise<number | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<number>("clear_recordings");
  } catch {
    return null;
  }
}

/** バイト数の人間向け表示(日本語 UI: MB 単位中心)。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
