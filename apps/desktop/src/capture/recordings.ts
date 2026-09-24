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

export interface RecordingFile {
  /** ファイル名(表示・削除キー)。 */
  name: string;
  /** バイト数。 */
  bytes: number;
  /** 更新時刻(UNIX秒)。 */
  modifiedSec: number;
}

/** 録音 WAV の一覧(#78)。Tauri 以外/失敗時は null。 */
export async function listRecordings(): Promise<RecordingFile[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<RecordingFile[]>("recordings_list");
  } catch {
    return null;
  }
}

/** 録音 WAV を1件削除する。成功時 true。 */
export async function deleteRecording(name: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("delete_recording", { name });
    return true;
  } catch {
    return false;
  }
}

/** 保持日数ポリシー(#87) — `days` より古い WAV を削除し、削除件数を返す。
 *  `days <= 0` は無効(何もしない)。アプリ起動時に一度呼ぶ想定。
 *  削除はユーザーが設定したポリシーの実行であり、確認ダイアログは出さない
 *  (設定自体が同意)。失敗時は 0 削除として扱う。
 *  #132: `keepNames` に含まれるファイル名は削除しない — 保存済み
 *  プロジェクトが参照する録音を retention が壊さないため。 */
export async function pruneRecordings(
  days: number,
  keepNames?: ReadonlySet<string>,
): Promise<number> {
  if (!isTauriRuntime() || days <= 0) return 0;
  const files = await listRecordings();
  if (!files) return 0;
  const cutoff = Date.now() / 1000 - days * 86400;
  let removed = 0;
  for (const f of files) {
    if (keepNames?.has(f.name)) continue;
    if (f.modifiedSec > 0 && f.modifiedSec < cutoff) {
      if (await deleteRecording(f.name)) removed += 1;
    }
  }
  return removed;
}

/** #132: 最近のプロジェクトが参照する録音 WAV のファイル名集合。
 *
 *  各プロジェクト JSON から sourceAudio.originalPath を読み、録音
 *  フォルダ(dir)配下にあるものだけを返す。読めないプロジェクトは
 *  スキップ(その参照は保護できない — 保持ポリシー側を優先する
 *  fail-open)。dir が取れない場合は何も保護しない。
 */
export async function collectReferencedRecordingNames(deps: {
  readProjectBytes(path: string): Promise<Blob>;
  entries: readonly { path: string }[];
  dir: string | null;
  /** project JSON -> sourcePath 抽出(controller.parseProjectFile と
   *  同じ契約; テストで差し替えやすいよう注入する)。 */
  sourcePathOf(bytes: Blob): Promise<string | null>;
}): Promise<Set<string>> {
  const keep = new Set<string>();
  const dir = deps.dir?.replace(/[\\/]+$/, "");
  if (!dir) return keep;
  const dirNorm = (dir + "\\").toLowerCase().replaceAll("/", "\\");
  for (const entry of deps.entries) {
    if (!entry.path) continue;
    try {
      const blob = await deps.readProjectBytes(entry.path);
      const sourcePath = await deps.sourcePathOf(blob);
      if (!sourcePath) continue;
      const norm = sourcePath.toLowerCase().replaceAll("/", "\\");
      if (norm.startsWith(dirNorm)) {
        keep.add(sourcePath.slice(dir.length + 1));
      }
    } catch {
      /* unreadable project: its references stay unknown (fail-open) */
    }
  }
  return keep;
}

/** #132: 録音を managed 領域 appDataDir/sources/ へコピーし、
 *  コピー先の絶対パスを返す。プロジェクト保存時に呼び、
 *  sourceAudio.originalPath を retention 対象外に向ける。
 *  Tauri 以外/失敗時は null — 呼び出し側は元パスのまま保存する
 *  (従来どおり keepNames が retention から守る)。 */
export async function copyRecordingToManaged(
  name: string,
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<string>("copy_recording_to_managed", { name });
  } catch {
    return null;
  }
}

/** ref.path が録音フォルダ dir 配下にあるとき、そのファイル名を返す。
 *  パス区切り差・大文字小文字差は吸収(collectReferencedRecordingNames
 *  と同じ正規化)。 */
export function recordingNameUnder(
  path: string,
  dir: string,
): string | null {
  const dirNorm =
    dir.replace(/[\\/]+$/, "").toLowerCase().replaceAll("/", "\\") + "\\";
  const norm = path.toLowerCase().replaceAll("/", "\\");
  if (!norm.startsWith(dirNorm)) return null;
  // Slice the ORIGINAL path so the returned name keeps its case —
  // normalization only changed separators/lowercase, never length.
  return path.slice(dirNorm.length);
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
