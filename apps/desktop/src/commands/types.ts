/**
 * Command model types (docs/GUI_UX_SPEC.md §23).
 *
 * A Command is a *stateless* description: predicates receive a
 * CommandSnapshot so the same definitions can be evaluated for menus,
 * keyboard dispatch, palette listing and tests without re-registering.
 */

/** Pitch display modes (GUI_UX_SPEC §7). Kept literal here so the command
 *  layer does not depend on a component file. */
export type PitchViewSetting = "concert" | "hornF";

/** Top-level screens that gate command availability. */
export type AppView = "workspace" | "settings";

/** Grouping for menus / command palette / docs. */
export type CommandSection =
  | "file"
  | "score"
  | "transport"
  | "view"
  | "review"
  | "edit"
  | "export"
  | "nav"
  | "app";

/**
 * Immutable read of the app state that command predicates evaluate.
 * The app builds one per render; the registry never stores it.
 */
export interface CommandSnapshot {
  /** A source audio file is loaded (GUI_UX_SPEC §4, AUDIO_READY+). */
  readonly hasAudio: boolean;
  /** A canonical score exists (SCORE_READY+). */
  readonly hasScore: boolean;
  /** Transcription is running — score-writing commands disable (§5). */
  readonly isTranscribing: boolean;
  /** Audio is currently playing (drives the play/pause affordance). */
  readonly isPlaying: boolean;
  /** Loop range playback is armed. */
  readonly loopEnabled: boolean;
  /** Current pitch display mode. */
  readonly pitch: PitchViewSetting;
  /** Undo/redo stacks (§14 — all edits are commands). */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** A note/region is selected (gates Esc = clear selection). */
  readonly hasSelection: boolean;
  /** #113: a waveform range selection exists (AUDIO_READY). Esc clears
   *  this before any score selection (spec 8: Esc -> 選択解除). */
  readonly hasWaveformSelection: boolean;
  /** 要確認 workspace state. */
  readonly reviewOpen: boolean;
  readonly reviewCount: number;
  /** FEAT-001: a recording session is in progress (loopback/mic). */
  readonly isRecording: boolean;
  /** FEAT-001 (#80): the recording session is paused. */
  readonly isRecordingPaused: boolean;
  /** FEAT-001: score audition (auto-playback of the score) is on. */
  readonly auditionEnabled: boolean;
  /** Active top-level view. */
  readonly view: AppView;
}

/**
 * The services commands act on. The app supplies implementations; during
 * the spike most are stubs that announce via `announce` so every invocation
 * produces honest feedback in the (aria-live) status bar.
 */
export interface CommandContext {
  openAudio(): void;
  transcribe(): void;
  /**
   * Cooperative `job.cancel` (UI-040): requests cancellation of the
   * in-flight transcription; the job still ends in a terminal `cancelled`
   * event, so callers must not assume an instant stop. Optional so older
   * test contexts keep compiling — an absent implementation is a no-op.
   */
  cancelTranscription?(): void;
  togglePlayPause(): void;
  stop(): void;
  jumpBack(): void;
  jumpForward(): void;
  seekToStart(): void;
  seekToEnd(): void;
  toggleLoop(): void;
  /**
   * FEAT-001 (#60): PC再生音源/マイク録音と楽譜自動演奏。
   * Optional so older test contexts keep compiling.
   */
  captureSystemAudio?(): void;
  captureMicrophone?(): void;
  /** 録音中なら停止して取り込む / 録音していなければ何もしない。 */
  stopCapture?(): void;
  /** 録音を中止して破棄する。 */
  cancelCapture?(): void;
  /** 録音を一時停止する(#80)。 */
  pauseCapture?(): void;
  /** 一時停止した録音を再開する(#80)。 */
  resumeCapture?(): void;
  /** 楽譜の自動演奏トグル(スコアクロックに同期して発音)。 */
  toggleScoreAudition?(): void;
  /** 元音源のミュート切替(#72)。楽譜の演奏だけを聴く用途。 */
  toggleSourceMute?(): void;
  setPitchView(view: PitchViewSetting): void;
  openReview(): void;
  reviewNext(): void;
  reviewPrevious(): void;
  /**
   * UI-050 review-workspace actions (GUI_UX_SPEC §12). Optional like
   * `cancelTranscription` so leaner test contexts keep compiling — an
   * absent implementation is a no-op.
   */
  reviewAccept?(): void;
  reviewDismiss?(): void;
  reviewPlaySource?(): void;
  reviewPitchUp?(): void;
  reviewPitchDown?(): void;
  reviewDeleteOrRestore?(): void;
  exitReview?(): void;
  undo(): void;
  redo(): void;
  openExport(): void;
  /** #100: プロジェクトを保存 — opens the save-file picker and writes
   *  .hornscribe.json through the engine. Optional like the other
   *  late-binding commands; absent = no-op. */
  saveProject?(): void;
  zoomScoreIn(): void;
  zoomScoreOut(): void;
  zoomScoreFit(): void;
  clearSelection(): void;
  /** #113: Esc on a waveform selection (AUDIO_READY) - clears the range
   *  back to "all" (spec 8: Esc -> 選択解除). Optional: absent = no-op. */
  clearWaveformSelection?(): void;
  openSettings(): void;
  /** Opens the 診断情報 sheet (§19 — separated from the normal UI). */
  openDiagnostics(): void;
  /** F6 region navigation — implemented by focus/zones. */
  focusNextRegion(): void;
  focusPreviousRegion(): void;
  /**
   * Surface command feedback in the status area (role="status" is
   * aria-live, so Narrator users hear the result — UX_VALIDATION §11).
   */
  announce(message: string): void;
}

/**
 * A single invocable command — the unit the registry, command bar, menus,
 * palette and keyboard dispatcher all share (single source of truth).
 */
export interface Command {
  /** Stable dotted id, e.g. "transport.playPause". */
  readonly id: string;
  /**
   * Japanese title — the only UI language (UI_COPY_CONTRACT). This is what
   * buttons, menus, a palette and screen readers all announce.
   */
  readonly title: string;
  /** Optional longer Japanese description for palettes/menus. */
  readonly description?: string;
  readonly section: CommandSection;
  /**
   * Keyboard bindings in "Ctrl+Shift+Z" notation; whitespace separates
   * chords in a multi-step sequence. The first entry is the canonical
   * binding shown in tooltips / aria-keyshortcuts.
   */
  readonly shortcuts?: readonly string[];
  /**
   * May run against this snapshot. Default: enabled. Disabled commands are
   * non-executable everywhere — toolbar, menu AND shortcut (issue req:
   * "disabled commands remain non-executable via shortcut").
   */
  readonly isEnabled?: (snapshot: CommandSnapshot) => boolean;
  /**
   * Listed on command surfaces (palette/menus/overflow). Default: visible.
   * Hidden commands still run when enabled — e.g. 採譜し直す vs 採譜.
   */
  readonly isVisible?: (snapshot: CommandSnapshot) => boolean;
  /** May fire while a text field / IME host has focus. Default false. */
  readonly allowInTextInput?: boolean;
  /** May fire while a modal dialog/sheet owns focus. Default false. */
  readonly allowInModal?: boolean;
  /** Re-fires on key auto-repeat. Default false (no accidental toggles). */
  readonly allowRepeat?: boolean;
  /** Execute against live services. */
  readonly run: (ctx: CommandContext, snapshot: CommandSnapshot) => void;
}
