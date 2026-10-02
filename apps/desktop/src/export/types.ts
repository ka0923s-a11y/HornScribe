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
 * The export choices of §17. ENG-001 semantics:
 * - `concertMusicxml` / `hornMusicxml` / `bFlatMusicxml` →
 *   `*_concert.musicxml` / `*_horn_in_f.musicxml` / `*_b_flat.musicxml`;
 *   the transposing artifacts carry written pitches plus the `<transpose>`
 *   element (-P5 for F, +M2 for B♭) so readers recover sounding pitch;
 * - `playbackMidi` → `*_playback.mid`, always *sounding* (concert) pitch —
 *   SMF has no transposing-instrument semantics, so a written-pitch MIDI
 *   would be ambiguous about its own pitch space (再生用MIDIは実音);
 * - `concertPdf` / `hornPdf` / `bFlatPdf` → rendered through MuseScore,
 *   hence gated by the MuseScore tool capability.
 * - `sourceAudio` → the original audio file copied alongside the score
 *   artifacts (#87 成果物同梱): a recording→score bundle stays usable
 *   outside the app. Gated by `capabilities.audioAvailable` — only refs
 *   backed by a real path can be copied.
 */
export type ExportFormatId =
  | "concertMusicxml"
  | "hornMusicxml"
  | "bFlatMusicxml"
  | "concertPdf"
  | "hornPdf"
  | "bFlatPdf"
  | "playbackMidi"
  | "sourceAudio";

/** Checkbox grouping from the spec mock-up (楽譜 / PDF / MIDI / 音声). */
export type ExportFormatGroup = "score" | "pdf" | "midi" | "audio";

export const EXPORT_FORMAT_GROUPS: Record<ExportFormatId, ExportFormatGroup> = {
  concertMusicxml: "score",
  hornMusicxml: "score",
  bFlatMusicxml: "score",
  concertPdf: "pdf",
  hornPdf: "pdf",
  bFlatPdf: "pdf",
  playbackMidi: "midi",
  sourceAudio: "audio",
};

export const EXPORT_FORMAT_IDS: readonly ExportFormatId[] = [
  "concertMusicxml",
  "hornMusicxml",
  "bFlatMusicxml",
  "concertPdf",
  "hornPdf",
  "bFlatPdf",
  "playbackMidi",
  "sourceAudio",
];

/**
 * The capability surface the export dialog needs — a subset of the engine
 * handshake plus local tool detection (MuseScore drives PDF availability;
 * FFmpeg is reported for consistency with diagnostics).
 */
/** #390: playback MIDI quality tier — "canonical" = the engine's
 *  exporter (velocity / pitch bend / swing / tempo map survive);
 *  "degraded" = the client-side MusicXML→MIDI rebuild, which drops
 *  those facets and must be disclosed; "unavailable" = no score
 *  document at all. */
export type PlaybackMidiTier = "canonical" | "degraded" | "unavailable";

export interface ExportCapabilities {
  readonly engineInfo: EngineInfo | null;
  readonly protocolVersion: number | null;
  /** Transcription backend id when known (diagnostics parity). */
  readonly backend: string | null;
  readonly museScore: ToolInfo;
  readonly ffmpeg: ToolInfo;
  /** #390: which MIDI producer the dialog can promise right now —
   *  an engine outage degrades playbackMidi without blocking the
   *  MusicXML/PDF formats that never needed the worker. */
  readonly playbackMidi: PlaybackMidiTier;
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
  /** #231: called once before writing when target names already
   *  exist — the host decides the collision policy for the whole set.
   *  "rename" re-stems every artifact to <basename>_N; "cancel"
   *  aborts the export with an EXPORT_CANCELLED result-free rejection.
   *  Absent = overwrite (non-interactive ports, tests). */
  readonly onCollision?: (
    existingNames: readonly string[],
  ) => Promise<"overwrite" | "rename" | "cancel">;
}

export interface ExportResult {
  readonly destination: string;
  readonly files: readonly ExportedFile[];
  /** #390: formats written at reduced quality (client-side MIDI
   *  rebuild instead of the engine exporter) — the dialog discloses
   *  the downgrade; absent/empty means every file is full quality. */
  readonly degraded?: readonly ExportFormatId[];
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
  /** No space left on the staging or destination device. */
  | "EXPORT_DISK_FULL"
  /** The source-audio file for the bundle vanished/moved. */
  | "EXPORT_SOURCE_MISSING"
  /** MuseScore ran (or failed to spawn) but the render did not
   *  succeed — distinct from the binary being absent. */
  | "EXPORT_MUSESCORE_RENDER_FAILED"
  /** Destination path does not exist or is not a usable directory. */
  | "EXPORT_DESTINATION_INVALID"
  /** A staged write/copy failed for a non-permission, non-space
   *  reason — nothing reached the destination. */
  | "EXPORT_WRITE_FAILED"
  /** The commit loop failed mid-way — a partial artifact set may
   *  exist in the destination (the dialog says so honestly). */
  | "EXPORT_COMMIT_FAILED"
  /** An artifact name failed Rust-side validation — a client-side
   *  generation bug, not something the user can fix. */
  | "EXPORT_NAME_INVALID"
  /** The rename loop found no free stem (999 collisions). */
  | "EXPORT_NAME_EXHAUSTED"
  /** Client-side/precondition failure (bad payload, no document). */
  | "EXPORT_INTERNAL"
  /** Anything else — generic failure with retry/diagnostics. */
  | "EXPORT_FAILED"
  /** #231: the user cancelled at the collision prompt — resolved
   *  quietly, not an error surface. */
  | "EXPORT_CANCELLED";

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
  export(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
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
    view: "concert" | "hornF" | "bFlat",
    overrides?: ToolPathOverrides,
  ): Promise<string>;
}
