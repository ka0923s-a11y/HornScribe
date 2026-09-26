/**
 * Import domain types (issue #25 / UI-020; docs/GUI_UX_SPEC.md §3/§4/§20).
 *
 * The import flow turns a user-picked file into a `LoadedAudio` the shell
 * can draw (waveform peaks + metadata) and play (UI-004 TransportController
 * contract media source), or into a recoverable `ImportIssue` rendered with
 * the copy-deck error shape (what failed / what is kept / next action).
 */

/** Advertised container formats (GUI_UX_SPEC §3: WAV・MP3・FLAC・M4A・OGG). */
export type AudioFormat = "wav" | "mp3" | "flac" | "m4a" | "ogg";

/**
 * A user-selected audio file. Inside Tauri the native dialog and the
 * window drag-drop event hand us real filesystem paths; in plain-browser
 * dev sessions the HTML drop/file-input hands us `File` objects.
 */
export type AudioFileRef =
  | { kind: "path"; path: string; name: string; contentHash?: string }
  | { kind: "file"; file: File; name: string; contentHash?: string };

/**
 * FEAT-001 (#60): 録音由来の疑似ファイル参照。
 * `kind: "recording"` はディスク上の実ファイルではなく、メモリ上の
 * 録音バッファを表す。`mediaSource.blob` に録音結果が入るので、
 * `LoadedAudio` としては既存経路と同じ振る舞いをする。
 */
export type RecordedAudioRef = {
  kind: "recording";
  /** UI 表示用の仮想ファイル名(例: "録音_20260922_153000.wav")。 */
  name: string;
  /** "loopback" | "microphone" — どこから録ったか。 */
  source: "loopback" | "microphone";
  /** Tauri: appDataDir/recordings/ に保存済みの実ファイルパス(#70)。
   *  ある場合は内容がディスク上に永続化されており、プロジェクトの
   *  sourceAudio(originalPath/contentHash)に載せられる。 */
  path?: string;
  /** path を持つ録音の SHA-256(FND-001 の contentHash 契約)。 */
  contentHash?: string;
  /** ブラウザ dev 等、実ファイルが無い場合の録音バイト列。 */
  blob?: Blob;
};

/**
 * What the UI-004 TransportController contract can load — mirrors the
 * spike's `AudioSource` (url | blob). We always hand over a blob: either
 * the dropped `File` itself or a Blob built from `read_audio_bytes`, so the
 * user-owned source file is only ever read, never modified.
 */
export type MediaSource = { kind: "url"; url: string } | { kind: "blob"; blob: Blob };

/** Fully decoded audio ready for the AUDIO_READY state (GUI_UX_SPEC §4). */
export interface LoadedAudio {
  /** Where the bytes came from (kept for relink/re-open bookkeeping). */
  ref: AudioFileRef | RecordedAudioRef;
  fileName: string;
  format: AudioFormat;
  sizeBytes: number;
  /** Audio-clock duration in seconds (0 while unknown). */
  durationSeconds: number;
  sampleRate: number;
  /** Normalized peak amplitudes 0–1 for the waveform strip. */
  peaks: readonly number[];
  /** Playback-ready source for the transport adapter. */
  mediaSource: MediaSource;
}

/**
 * Recoverable import failures — every variant has a copy-deck title/body
 * plus a recovery action, so errors never dead-end (acceptance: "invalid
 * file has actionable Japanese error", "unsupported codec does not
 * dead-end").
 */
export type ImportIssue =
  /** Extension is not in the advertised set — honest format guidance. */
  | { kind: "unsupported"; fileName: string }
  /** Read/decode failed (corrupt file, vanished path, codec the webview
      cannot decode and FFmpeg normalization has not landed yet). */
  | { kind: "openFailed"; fileName?: string }
  /** `.hornscribe.json` could not be read or parsed. `path` is the MRU
   *  path that failed — powers the 履歴から削除 action on the error card
   *  and the launch auto-open skip set (#364); absent for byte-opens. */
  | { kind: "projectOpenFailed"; fileName: string; path?: string };

/**
 * The subset of `HornScribeProject` (python/hornscribe/project/model.py,
 * schema v1) the relink UX needs. `sourcePath`/`sourceHash` mirror
 * `sourceAudio.originalPath` / `contentHash`.
 */
export interface ProjectSummary {
  /** Absolute path of the .hornscribe.json file itself. */
  path: string;
  projectId: string;
  /** Display name — file basename without the .hornscribe.json suffix. */
  name: string;
  sourcePath: string | null;
  sourceHash: string | null;
  /** Saved job-result extras (#106): when the file carries
   *  musicXmlConcert/musicXmlHornF + score.revision + reviewIssues,
   *  this mirrors the completed-job `result` payload so the score can
   *  be restored without re-transcribing. Null for projects without
   *  saved score data (externally authored files). */
 scoreResult: unknown | null;
  /** #264: the saved `transcription.settings` echo (provenance). The
   *  host restores it into 採譜オプション so 採譜し直す reruns under
   *  the conditions that produced this project, not the current
   *  global defaults. Null for externally authored files. */
  transcriptionSettings: Record<string, unknown> | null;
  /** #391: the open came from the `.recovery` sibling because the main
   *  file was unreadable — the host announces the restore and keeps the
   *  document dirty so Ctrl+S repairs the main file. */
  recovered?: boolean;
}

/** SOURCE_MISSING context: which project lost its audio, and whether the
 *  last relink candidate failed the content-hash check (deck:
 *  sourceMoved vs sourceHashMismatch copy). */
export interface SourceMissingInfo {
  project: ProjectSummary;
  mismatch: boolean;
}

/** A "最近使ったプロジェクト" entry (GUI_UX_SPEC §3). */
export interface RecentProjectEntry {
  name: string;
  path: string;
  /** Epoch ms of the last successful open (sorting + pruning). */
  openedAt: number;
}

/**
 * 採譜オプション (GUI_UX_SPEC §4 advanced options — hidden in the popover
 * next to 採譜を開始). Values are option keys; Japanese labels resolve via
 * ja.import.audioOptions. Consumed by the transcription feature (UI-040),
 * persisted nowhere yet.
 */
export interface TranscriptionOptions {
  tempo: "auto" | "manual";
  tempoBpm: number | null;
  meter: string;
  minDuration: string;
  triplets: "auto" | "allow" | "none";
  simplicity: "standard" | "simple" | "detailed";
  range: "all" | "selection";
  /** 音源の種類 — mono=単旋律楽器, melody=メロディ優先(ミックス/JPOP),
      auto=重なりの多さからエンジンが自動判定。 */
  texture: "auto" | "mono" | "melody" | "voices" | "chords";
  /** #355: voice cap for the voices/chords textures (engine maxVoices,
   *  2..8). 3 keeps the long-standing default; 4-part harmony needs 4+. */
  maxVoices: number;
  /** #189: per-job engine override. "auto" inherits the global
   *  設定→詳細設定 backend; an explicit choice pins this job only. */
  backend: "auto" | "basicPitch" | "pyin";
  /** #187: opt-in vocal isolation — the backend runs on a
   *  center-extracted vocal estimate instead of the raw mix. */
  vocalIsolation: boolean;
  /** 範囲指定時の開始/終了（秒）。null = 音声の端まで。 */
  selectionStartSec: number | null;
  selectionEndSec: number | null;
}

export const DEFAULT_TRANSCRIPTION_OPTIONS: TranscriptionOptions = {
  tempo: "auto",
  tempoBpm: null,
  meter: "auto",
  minDuration: "16",
  triplets: "auto",
  simplicity: "standard",
  range: "all",
  texture: "auto",
  maxVoices: 3,
  backend: "auto",
  vocalIsolation: false,
  selectionStartSec: null,
  selectionEndSec: null,
};
