/**
 * Export contract types (UI-060; GUI_UX_SPEC §17; ENG-001 semantics).
 *
 * The dialog talks to a typed {@link ExportPort} (port.ts) — the same
 * port/gate layering the sidecar client uses (`src/sidecar/port.ts` in
 * UI-040): a mock port makes the whole UX exercisable in a plain browser,
 * while a real engine reports the same capability surface through the
 * `engine.handshake` response once the spawn bridge lands.
 */

import type {
  EngineInfo,
  ToolInfo,
  ToolPathOverrides,
} from "../diagnostics/types";

/**
 * The five export choices of §17. ENG-001 semantics:
 * - `concertMusicxml` / `hornMusicxml` → `*_concert.musicxml` /
 *   `*_horn_in_f.musicxml`; the F管ホルン artifact carries written pitches
 *   plus the -P5 `<transpose>` element so readers recover sounding pitch;
 * - `playbackMidi` → `*_playback.mid`, always *sounding* (concert) pitch —
 *   SMF has no transposing-instrument semantics, so a written-pitch MIDI
 *   would be ambiguous about its own pitch space (再生用MIDIは実音);
 * - `concertPdf` / `hornPdf` → rendered through MuseScore, hence gated by
 *   the MuseScore tool capability.
 * - `sourceAudio` → the original audio file copied alongside the score
 *   artifacts (#87 成果物同梱): a recording→score bundle stays usable
 *   outside the app. Gated by `capabilities.audioAvailable` — only refs
 *   backed by a real path can be copied.
 */
export type ExportFormatId =
  | "concertMusicxml"
  | "hornMusicxml"
  | "concertPdf"
  | "hornPdf"
  | "playbackMidi"
  | "sourceAudio";

/** Checkbox grouping from the spec mock-up (楽譜 / PDF / MIDI / 音声). */
export type ExportFormatGroup = "score" | "pdf" | "midi" | "audio";

export const EXPORT_FORMAT_GROUPS: Record<ExportFormatId, ExportFormatGroup> = {
  concertMusicxml: "score",
  hornMusicxml: "score",
  concertPdf: "pdf",
  hornPdf: "pdf",
  playbackMidi: "midi",
  sourceAudio: "audio",
};

export const EXPORT_FORMAT_IDS: readonly ExportFormatId[] = [
  "concertMusicxml",
  "hornMusicxml",
  "concertPdf",
  "hornPdf",
  "playbackMidi",
  "sourceAudio",
];

/**
 * The capability surface the export dialog needs — a subset of the engine
 * handshake plus local tool detection (MuseScore drives PDF availability;
 * FFmpeg is reported for consistency with diagnostics).
 */
export interface ExportCapabilities {
  readonly engineInfo: EngineInfo | null;
  readonly protocolVersion: number | null;
  /** Transcription backend id when known (diagnostics parity). */
  readonly backend: string | null;
  readonly museScore: ToolInfo;
  readonly ffmpeg: ToolInfo;
  /** True when the loaded audio is backed by a real path and can be
   *  copied into the export bundle (sourceAudio format, #87). */
  readonly audioAvailable: boolean;
}

/** PDF export requires MuseScore; everything else stays available (§17). */
export function pdfBlocked(capabilities: ExportCapabilities): boolean {
  return capabilities.museScore.status !== "found";
}

/** A single written artifact returned by a successful export. */
export interface ExportedFile {
  readonly format: ExportFormatId;
  /** Absolute path of the written file. */
  readonly path: string;
  /** File name only (for display). */
  readonly name: string;
}

export interface ExportRequest {
  /** Formats to write — at least one, all enabled by capabilities. */
  readonly formats: readonly ExportFormatId[];
  /** Destination directory (absolute path). */
  readonly destination: string;
  /** Document base name for `<basename>_<artifact>` naming (ENG-001). */
  readonly basename?: string;
}

export interface ExportResult {
  readonly destination: string;
  readonly files: readonly ExportedFile[];
}

/**
 * Stable error codes the UI maps onto Japanese recovery copy — raw engine
 * messages and stack traces never reach the dialog (§20, acceptance:
 * "technical stack trace is not shown in normal error UI").
 */
export type ExportErrorCode =
  /** Destination is not writable (permission / read-only). */
  | "PERMISSION_DENIED"
  /** No engine connected (sidecar not spawned / crashed). */
  | "ENGINE_UNAVAILABLE"
  /** PDF was requested without a usable MuseScore. */
  | "MUSESCORE_UNAVAILABLE"
  /** Anything else — generic failure with retry/choose-destination. */
  | "EXPORT_FAILED";

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

/** Maps an unknown thrown value to a stable code for the dialog. */
export function exportErrorCode(err: unknown): ExportErrorCode {
  if (err instanceof ExportError) return err.code;
  return "EXPORT_FAILED";
}

/**
 * ExportPort — the seam between the 書き出し dialog and a concrete export
 * backend (see port.ts for the runtime gate). Declared here with the rest
 * of the contract so implementations never import the port module itself.
 */
export interface ExportPort {
  /**
   * Probe export-relevant capabilities: engine identity, protocol version,
   * backend and tool detection. `overrides` carries the user-specified tool
   * paths from 設定 → ツール/書き出し (non-empty paths win over probing).
   * Rejects with ExportError(ENGINE_UNAVAILABLE) when no engine/backend
   * can answer — the dialog shows the recovery surface, not a crash.
   */
  capabilities(overrides?: ToolPathOverrides): Promise<ExportCapabilities>;
  /**
   * Ask the user for a destination directory (native picker where a real
   * bridge exists). Resolves null when the picker was cancelled.
   */
  chooseDestination(current?: string): Promise<string | null>;
  /**
   * The directory preselected in the dialog: the 設定 → 書き出し default
   * when set, else the engine/OS documents location.
   */
  defaultDestination(): Promise<string>;
  /**
   * Run the export. Resolves with the written artifacts; rejects with a
   * typed {@link ExportError} whose code drives the §20 recovery surface —
   * raw engine output/stack traces stay behind the port.
   */
  export(request: ExportRequest): Promise<ExportResult>;
  /**
   * Reveal a directory in the OS file manager (エクスプローラーで表示).
   * Resolves false where the bridge cannot do that — the caller announces
   * the failure instead of pretending.
   */
  revealInExplorer(path: string): Promise<boolean>;
  /**
   * §13 高度編集: open the live score (user edits included) in the
   * MuseScore GUI — stages the current view's MusicXML to a temp file
   * and launches the detected/user-pinned executable. Resolves the
   * staged path; rejects with ExportError(MUSESCORE_UNAVAILABLE) when
   * no MuseScore is usable. Optional so browser/mock ports and leaner
   * test doubles keep compiling — an absent implementation is a no-op.
   */
  openInMuseScore?(
    view: "concert" | "hornF",
    overrides?: ToolPathOverrides,
  ): Promise<string>;
}
