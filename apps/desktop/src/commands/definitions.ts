/**
 * Built-in command definitions (docs/GUI_UX_SPEC.md §7, §9, §14, §15, §22).
 *
 * This is the single source of truth: command bar buttons, menus, a future
 * command palette and the keyboard dispatcher all consume this list —
 * components never define their own shortcut handlers.
 *
 * Shortcut table (issue UI-012 / spec §9, §15, §22):
 *   Ctrl+O          open audio          F6 / Shift+F6   region cycle
 *   Space / K       play-pause          Ctrl+Z          undo
 *   Shift+Space     stop                Ctrl+Shift+Z    redo
 *   J / L           jump back/forward   Ctrl+E          export
 *   Home / End      start/end           Ctrl++ Ctrl+-   score zoom
 *   Ctrl+L          loop toggle         Ctrl+0          zoom to width
 *   Ctrl+1 / Ctrl+2 concert / F-horn    Esc             clear selection
 *
 * UI-050 review workspace (§12 — active while reviewOpen; the P4-validated
 * key set, so ← → are owned by issue navigation until per-note arrow
 * navigation lands and must share them through one command):
 *   ← / →           previous/next issue Alt+↑ / Alt+↓  pitch ±1 semitone
 *   R               replay source       Delete          delete/restore note
 *   O / Shift+O     accept / dismiss    Esc             exit review
 */

import { ja } from "../strings/ja";
import type { Command, CommandSnapshot } from "./types";

const hasAudio = (s: CommandSnapshot) => s.hasAudio;
const hasScore = (s: CommandSnapshot) => s.hasScore;
/* #366: transport falls back to the score clock when no audio is
 * loaded — the commands must stay reachable in a score-only state
 * (restored project / SOURCE_MISSING), not just under hasAudio. */
const canPlay = (s: CommandSnapshot) => s.hasAudio || s.hasScore;
const canEditScore = (s: CommandSnapshot) => s.hasScore && !s.isTranscribing;

/**
 * All built-in commands. Order is the canonical listing order (command
 * palette / docs); `section` groups them for menus.
 */
export function createCommandDefinitions(): readonly Command[] {
  return [
    // ---- file ----
    {
      id: "file.openAudio",
      title: ja.commands.openAudio,
      section: "file",
      shortcuts: ["Ctrl+O"],
      // 録音中に別の音源を開くと、完了した録音が取り込み先を失って
      // 黙って上書きする — 録音中は無効化する。
      isEnabled: (s) => !s.isRecording,
      run: (ctx) => ctx.openAudio(),
    },
    {
      // #369: project open is its own command — resuming saved work
      // must be discoverable, not buried in the audio picker's
      // all-files escape hatch.
      id: "file.openProject",
      title: ja.commands.openProject,
      section: "file",
      shortcuts: ["Ctrl+Shift+O"],
      isEnabled: (s) => !s.isRecording,
      run: (ctx) => ctx.openProject(),
    },

    // ---- score ----
    {
      id: "score.transcribe",
      title: ja.commands.transcribe,
      section: "score",
      // §5: rewriting the canonical score mid-transcription is forbidden.
      // 録音中は音声ソースが確定していないので採譜を始めさせない。
      isEnabled: (s) => s.hasAudio && !s.isTranscribing && !s.isRecording,
      run: (ctx) => ctx.transcribe(),
    },
    {
      id: "score.retranscribe",
      title: ja.commands.retranscribe,
      section: "score",
      // Same action as 採譜 once a score exists; the command bar relabels.
      isEnabled: (s) => s.hasScore && !s.isTranscribing && !s.isRecording,
      isVisible: (s) => s.hasScore,
      run: (ctx) => ctx.transcribe(),
    },
    {
      // #55: open the transcription-options dialog from the score
      // screen — the popover only exists on AUDIO_READY, so after a
      // transcription there was no way to change 調/meter/etc. and
      // retry. Score-only visibility: AUDIO_READY already has the
      // popover next to 採譜を開始.
      id: "score.transcribeOptions",
      title: ja.commands.transcribeOptions,
      section: "score",
      isEnabled: (s) => s.hasAudio && !s.isTranscribing && !s.isRecording,
      isVisible: (s) => s.hasScore,
      run: (ctx) => ctx.openTranscribeOptions?.(),
    },
    {
      id: "score.cancelTranscription",
      title: ja.commands.cancelTranscription,
      section: "score",
      // §5/§27: cooperative job.cancel — only meaningful while a job is
      // in flight. Deliberately no shortcut: Esc must never silently
      // cancel a running transcription.
      isEnabled: (s) => s.isTranscribing,
      isVisible: (s) => s.isTranscribing,
      run: (ctx) => ctx.cancelTranscription?.(),
    },
    {
      id: "score.zoomIn",
      title: ja.commands.zoomScoreIn,
      section: "score",
      // "+" needs Shift on US/JIS layouts; "Ctrl+=" is the unshifted twin.
      // The numpad "+" also arrives as key "+" so no extra binding is needed.
      shortcuts: ["Ctrl+=", "Ctrl++"],
      isEnabled: canEditScore,
      run: (ctx) => ctx.zoomScoreIn(),
    },
    {
      id: "score.zoomOut",
      title: ja.commands.zoomScoreOut,
      section: "score",
      shortcuts: ["Ctrl+-"],
      isEnabled: canEditScore,
      run: (ctx) => ctx.zoomScoreOut(),
    },
    {
      id: "score.zoomFit",
      title: ja.commands.zoomScoreFit,
      section: "score",
      shortcuts: ["Ctrl+0"],
      isEnabled: canEditScore,
      run: (ctx) => ctx.zoomScoreFit(),
    },

    // ---- transport (§9) ----
    {
      id: "transport.playPause",
      title: ja.commands.playPause,
      section: "transport",
      shortcuts: ["Space", "K"],
      isEnabled: canPlay,
      run: (ctx) => ctx.togglePlayPause(),
    },
    {
      id: "transport.stop",
      title: ja.commands.stop,
      section: "transport",
      shortcuts: ["Shift+Space"],
      isEnabled: canPlay,
      run: (ctx) => ctx.stop(),
    },
    {
      id: "transport.jumpBack",
      title: ja.commands.jumpBack,
      section: "transport",
      shortcuts: ["J"],
      allowRepeat: true, // holding J/L scrubs, like video editors
      isEnabled: canPlay,
      run: (ctx) => ctx.jumpBack(),
    },
    {
      id: "transport.jumpForward",
      title: ja.commands.jumpForward,
      section: "transport",
      shortcuts: ["L"],
      allowRepeat: true,
      isEnabled: canPlay,
      run: (ctx) => ctx.jumpForward(),
    },
    {
      id: "transport.seekStart",
      title: ja.commands.seekStart,
      section: "transport",
      shortcuts: ["Home"],
      isEnabled: canPlay,
      run: (ctx) => ctx.seekToStart(),
    },
    {
      id: "transport.seekEnd",
      title: ja.commands.seekEnd,
      section: "transport",
      shortcuts: ["End"],
      isEnabled: canPlay,
      run: (ctx) => ctx.seekToEnd(),
    },
    {
      id: "transport.toggleLoop",
      title: ja.commands.toggleLoop,
      section: "transport",
      shortcuts: ["Ctrl+L"],
      isEnabled: canPlay,
      run: (ctx) => ctx.toggleLoop(),
    },
    {
      id: "transport.toggleAudition",
      title: ja.commands.toggleAudition,
      shortcuts: ["P"],
      section: "transport",
      // 楽譜の演奏はスコアがある時だけ意味を持つ。録音中は鳴らさない
      // (#72): ループバック録音に演奏音が混入する + マイク録音でも
      // スピーカー音を拾うため。
      isEnabled: (s) => hasScore(s) && !s.isRecording,
      run: (ctx) => ctx.toggleScoreAudition?.(),
    },
    {
      id: "transport.toggleSourceMute",
      title: ja.commands.toggleSourceMute,
      section: "transport",
      // #72: 元音源だけをミュートして楽譜の演奏を確認する用途。
      // ミュートはメディア要素の属性なので録音中でも有効(録音対象の
      // ループバック音は止まらない)が、混乱を避け録音中も許可する。
      isEnabled: hasAudio,
      run: (ctx) => ctx.toggleSourceMute?.(),
    },

    // ---- capture (FEAT-001 #60) ----
    {
      id: "media.captureSystemAudio",
      title: ja.commands.captureSystemAudio,
      section: "file",
      // 録音は audio 無しでも始められる(結果が新しい audio になる)。
      isEnabled: (s) => !s.isTranscribing && !s.isRecording,
      run: (ctx) => ctx.captureSystemAudio?.(),
    },
    {
      id: "media.captureMicrophone",
      title: ja.commands.captureMicrophone,
      section: "file",
      isEnabled: (s) => !s.isTranscribing && !s.isRecording,
      run: (ctx) => ctx.captureMicrophone?.(),
    },
    {
      id: "media.openQueue",
      title: ja.commands.openQueue,
      section: "file",
      run: (ctx) => ctx.openQueue?.(),
    },
    {
      id: "media.enqueueAudio",
      title: ja.commands.enqueueAudio,
      section: "file",
      isEnabled: (s) => !s.isTranscribing && !s.isRecording,
      run: (ctx) => ctx.enqueueAudio?.(),
    },
    {
      id: "media.stopCapture",
      title: ja.commands.stopCapture,
      section: "file",
      isEnabled: (s) => s.isRecording,
      isVisible: (s) => s.isRecording,
      run: (ctx) => ctx.stopCapture?.(),
    },
    {
      id: "media.cancelCapture",
      title: ja.commands.cancelCapture,
      section: "file",
      isEnabled: (s) => s.isRecording,
      isVisible: (s) => s.isRecording,
      run: (ctx) => ctx.cancelCapture?.(),
    },
    {
      // #80: 停止/再開は別コマンド(表示は録音中のみ)。
      id: "media.pauseCapture",
      title: ja.commands.pauseCapture,
      section: "file",
      isEnabled: (s) => s.isRecording && !s.isRecordingPaused,
      isVisible: (s) => s.isRecording,
      run: (ctx) => ctx.pauseCapture?.(),
    },
    {
      id: "media.resumeCapture",
      title: ja.commands.resumeCapture,
      section: "file",
      isEnabled: (s) => s.isRecording && s.isRecordingPaused,
      isVisible: (s) => s.isRecording,
      run: (ctx) => ctx.resumeCapture?.(),
    },

    // ---- view (§7: explicit pair, not a toggle) ----
    {
      id: "view.concertPitch",
      title: ja.commands.concertPitch,
      section: "view",
      shortcuts: ["Ctrl+1"],
      run: (ctx) => ctx.setPitchView("concert"),
    },
    {
      id: "view.hornF",
      title: ja.commands.hornF,
      section: "view",
      shortcuts: ["Ctrl+2"],
      run: (ctx) => ctx.setPitchView("hornF"),
    },

    // ---- review (§12, UI-050 keyboard-first flow) ----
    {
      id: "review.open",
      title: ja.commands.openReview,
      section: "review",
      // #361: gated on total (open + decided) — a fully-resolved score
      //  keeps review reachable so the decision history can be
      //  revisited (and reopened) after save/reopen kills the undo
      //  stack. The bar's pending count still reads from reviewCount.
      isEnabled: (s) => s.hasScore && s.reviewTotal > 0,
      isVisible: (s) => s.hasScore && s.reviewTotal > 0,
      run: (ctx) => ctx.openReview(),
    },
    {
      id: "review.next",
      title: ja.commands.reviewNext,
      section: "review",
      // §12 header has a 次へ button too — the arrow keys keep review
      // processing menu-free (acceptance: 20 items without menus).
      shortcuts: ["ArrowRight"],
      // #114: shared with score.selectNext - mutually exclusive by
      // reviewOpen; the dispatcher picks the enabled one.
      shareShortcut: true,
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewNext(),
    },
    {
      id: "review.previous",
      title: ja.commands.reviewPrevious,
      section: "review",
      shortcuts: ["ArrowLeft"],
      shareShortcut: true, // shared with score.selectPrevious (#114)
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPrevious(),
    },
    {
      id: "review.playSource",
      title: ja.commands.reviewPlaySource,
      section: "review",
      shortcuts: ["R"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPlaySource?.(),
    },
    {
      id: "review.accept",
      title: ja.commands.reviewAccept,
      section: "review",
      shortcuts: ["O"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewAccept?.(),
    },
    {
      id: "review.dismiss",
      title: ja.commands.reviewDismiss,
      section: "review",
      shortcuts: ["Shift+O"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewDismiss?.(),
    },
    {
      id: "review.navigator",
      title: ja.commands.reviewNavigator,
      section: "review",
      // #361: I toggles the issue-list popover. allowInModal so the
      //  same key also closes it while the (role=dialog) panel owns
      //  focus.
      shortcuts: ["I"],
      allowInModal: true,
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewToggleNavigator?.(),
    },
    {
      id: "review.pitchUp",
      title: ja.commands.reviewPitchUp,
      section: "review",
      shortcuts: ["Alt+ArrowUp"],
      shareShortcut: true, // shared with score.pitchUp (#114)
      isEnabled: (s) => s.reviewOpen && s.reviewIssueEditable,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPitchUp?.(),
    },
    {
      id: "review.pitchDown",
      title: ja.commands.reviewPitchDown,
      section: "review",
      shortcuts: ["Alt+ArrowDown"],
      shareShortcut: true, // shared with score.pitchDown (#114)
      isEnabled: (s) => s.reviewOpen && s.reviewIssueEditable,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPitchDown?.(),
    },
    {
      id: "review.deleteOrRestore",
      title: ja.commands.reviewDeleteOrRestore,
      section: "review",
      shortcuts: ["Delete", "Backspace"],
      shareShortcut: true, // shared with score.toggleDeleted (#114)
      isEnabled: (s) => s.reviewOpen && s.reviewIssueEditable,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewDeleteOrRestore?.(),
    },
    {
      id: "review.exit",
      title: ja.commands.reviewExit,
      section: "review",
      // Esc is bound to edit.clearSelection, which exits review first —
      // this command exists so button/menu surfaces share one label.
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.exitReview?.(),
    },

    // ---- score note navigation + edits (#114, spec 10/13) ----
    // Arrow keys are shared with the review workspace: these stay
    // disabled while review is open so review.next/previous own them.
    {
      id: "score.selectNext",
      title: ja.commands.selectNextNote,
      section: "score",
      shortcuts: ["ArrowRight"],
      shareShortcut: true, // shared with review.next (#114)
      isEnabled: (s) => s.hasScore && !s.reviewOpen,
      run: (ctx) => ctx.selectAdjacentNote?.(1),
    },
    {
      id: "score.selectPrevious",
      title: ja.commands.selectPreviousNote,
      section: "score",
      shortcuts: ["ArrowLeft"],
      shareShortcut: true, // shared with review.previous (#114)
      isEnabled: (s) => s.hasScore && !s.reviewOpen,
      run: (ctx) => ctx.selectAdjacentNote?.(-1),
    },
    {
      id: "score.pitchUp",
      title: ja.commands.notePitchUp,
      section: "score",
      shortcuts: ["Alt+ArrowUp"],
      shareShortcut: true, // shared with review.pitchUp (#114)
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.editSelectedPitch?.(1),
    },
    {
      id: "score.pitchDown",
      title: ja.commands.notePitchDown,
      section: "score",
      shortcuts: ["Alt+ArrowDown"],
      shareShortcut: true, // shared with review.pitchDown (#114)
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.editSelectedPitch?.(-1),
    },
    {
      id: "score.toggleDeleted",
      title: ja.commands.noteToggleDeleted,
      section: "score",
      shortcuts: ["Delete", "Backspace"],
      shareShortcut: true, // shared with review.deleteOrRestore (#114)
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.toggleSelectedDeleted?.(),
    },
    {
      id: "score.toggleEnharmonic",
      title: ja.commands.noteEnharmonic,
      section: "score",
      shortcuts: ["E"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.toggleSelectedEnharmonic?.(),
    },
    {
      // #115 (spec 13): rhythm edits need the engine (score.edit), so
      // they live behind the same hasScore+selection gate; the workspace
      // announces honestly when the document cannot take them (fixture)
      // or the engine rejects the edit (span does not fit, no tie
      // partner, ...).
      id: "score.noteLonger",
      title: ja.commands.noteLonger,
      section: "score",
      shortcuts: ["Ctrl+Shift+ArrowUp"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.noteDurationScale?.(1),
    },
    {
      id: "score.noteShorter",
      title: ja.commands.noteShorter,
      section: "score",
      shortcuts: ["Ctrl+Shift+ArrowDown"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.noteDurationScale?.(-1),
    },
    {
      id: "score.noteShiftLeft",
      title: ja.commands.noteShiftLeft,
      section: "score",
      shortcuts: ["Ctrl+Shift+ArrowLeft"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.shiftSelectedOnset?.(-1),
    },
    {
      id: "score.noteShiftRight",
      title: ja.commands.noteShiftRight,
      section: "score",
      shortcuts: ["Ctrl+Shift+ArrowRight"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.shiftSelectedOnset?.(1),
    },
    {
      id: "score.toggleTie",
      title: ja.commands.noteToggleTie,
      section: "score",
      shortcuts: ["T"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.toggleSelectedTie?.(),
    },
    // #130 (spec 14): re-quantize under changed settings — menu-only
    // discoverability; the dialog owns the actual edit.
    {
      id: "score.requantize",
      title: ja.commands.requantize,
      section: "score",
      isEnabled: (s) => s.hasScore && !s.reviewOpen,
      run: (ctx) => ctx.openRequantizeDialog?.(),
    },
    // #131 (spec 13 post-MVP): split/merge — engine edits on the
    // selected note, same gate as the other rhythm edits.
    {
      id: "score.splitNote",
      title: ja.commands.noteSplit,
      section: "score",
      shortcuts: ["S"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.splitSelectedNote?.(),
    },
    {
      id: "score.mergeNotes",
      title: ja.commands.noteMerge,
      section: "score",
      shortcuts: ["M"],
      isEnabled: (s) => s.hasScore && s.hasSelection && !s.reviewOpen,
      run: (ctx) => ctx.mergeSelectedNotes?.(),
    },
    // #163: rest-to-note — converts (part of) the selected rest span
    // into a note at the previous note's pitch (editable after).
    {
      id: "score.restToNote",
      title: ja.commands.restToNote,
      section: "score",
      shortcuts: ["N"],
      isEnabled: (s) => s.hasScore && s.hasRestSelection && !s.reviewOpen,
      run: (ctx) => ctx.convertSelectedRest?.(),
    },

    // #267: octave arrange — one canonical transposeRange edit for
    // the whole score (a real pitch change, NOT the F管 view
    // projection); the engine rejects moves that would leave MIDI
    // 0..127.
    {
      id: "score.octaveUp",
      title: ja.commands.scoreOctaveUp,
      section: "score",
      isEnabled: (s) => s.hasScore && !s.reviewOpen,
      run: (ctx) => ctx.transposeScore?.(12),
    },
    {
      id: "score.octaveDown",
      title: ja.commands.scoreOctaveDown,
      section: "score",
      isEnabled: (s) => s.hasScore && !s.reviewOpen,
      run: (ctx) => ctx.transposeScore?.(-12),
    },

    // ---- edit (§14: every fix is a command) ----
    {
      id: "edit.undo",
      title: ja.commands.undo,
      section: "edit",
      shortcuts: ["Ctrl+Z"],
      isEnabled: (s) => s.canUndo,
      run: (ctx) => ctx.undo(),
    },
    {
      id: "edit.redo",
      title: ja.commands.redo,
      section: "edit",
      shortcuts: ["Ctrl+Shift+Z"],
      isEnabled: (s) => s.canRedo,
      run: (ctx) => ctx.redo(),
    },
    {
      id: "edit.clearSelection",
      title: ja.commands.clearSelection,
      section: "edit",
      shortcuts: ["Escape"],
      // Esc exits the review workspace before it clears a selection (§12
      // review exit, controller.clearSelection owns the order) — so it
      // must stay enabled with the review bar up even when nothing is
      // selected (e.g. all issues resolved). #113: a waveform range
      // selection (AUDIO_READY) is cleared first (spec 8 Esc → 選択解除).
      isEnabled: (s) =>
        s.hasSelection || s.reviewOpen || s.hasWaveformSelection,
      run: (ctx, s) => {
        if (s.hasWaveformSelection) ctx.clearWaveformSelection?.();
        else ctx.clearSelection();
      },
    },

    // ---- export ----
    {
      id: "export.open",
      title: ja.commands.export,
      section: "export",
      shortcuts: ["Ctrl+E"],
      isEnabled: hasScore,
      run: (ctx) => ctx.openExport(),
    },
    {
      id: "export.openInMuseScore",
      title: ja.commands.openInMuseScore,
      section: "export",
      // No shortcut: an app-launch action stays menu-only (§13).
      isEnabled: hasScore,
      run: (ctx) => ctx.openInMuseScore?.(),
    },

    // ---- project save (#100) ----
    {
      id: "project.save",
      title: ja.commands.saveProject,
      section: "file",
      shortcuts: ["Ctrl+S"],
      isEnabled: (s) => s.hasScore && !s.isTranscribing,
      run: (ctx) => ctx.saveProject?.(),
    },
    // #221: Save As — same gate, always re-picks the destination.
    {
      id: "project.saveAs",
      title: ja.commands.saveProjectAs,
      section: "file",
      shortcuts: ["Ctrl+Shift+S"],
      isEnabled: (s) => s.hasScore && !s.isTranscribing,
      run: (ctx) => ctx.saveProjectAs?.(),
    },

    // ---- navigation / focus (§22: F6 cycles the major regions) ----
    {
      id: "nav.nextRegion",
      title: ja.commands.nextRegion,
      section: "nav",
      shortcuts: ["F6"],
      run: (ctx) => ctx.focusNextRegion(),
    },
    {
      id: "nav.previousRegion",
      title: ja.commands.previousRegion,
      section: "nav",
      shortcuts: ["Shift+F6"],
      run: (ctx) => ctx.focusPreviousRegion(),
    },

    // ---- app ----
    {
      id: "app.settings",
      title: ja.commands.settings,
      section: "app",
      run: (ctx) => ctx.openSettings(),
    },
    {
      id: "app.diagnostics",
      title: ja.commands.diagnostics,
      section: "app",
      run: (ctx) => ctx.openDiagnostics(),
    },
    {
      // #318: keyboard-shortcuts help — F1 is the platform convention.
      id: "app.help",
      title: ja.commands.help,
      section: "app",
      shortcuts: ["F1"],
      run: (ctx) => ctx.openShortcutsHelp?.(),
    },
    {
      // #406: the command palette — quick-launch surface over this same
      // registry. It opts back into modal + text-input scopes so Ctrl+K
      // toggles it shut again from inside its own search field.
      id: "app.commandPalette",
      title: ja.commands.commandPalette,
      section: "app",
      shortcuts: ["Ctrl+K"],
      allowInModal: true,
      allowInTextInput: true,
      run: (ctx) => ctx.openCommandPalette?.(),
    },
  ];
}
