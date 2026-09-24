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
      isEnabled: hasAudio,
      run: (ctx) => ctx.togglePlayPause(),
    },
    {
      id: "transport.stop",
      title: ja.commands.stop,
      section: "transport",
      shortcuts: ["Shift+Space"],
      isEnabled: hasAudio,
      run: (ctx) => ctx.stop(),
    },
    {
      id: "transport.jumpBack",
      title: ja.commands.jumpBack,
      section: "transport",
      shortcuts: ["J"],
      allowRepeat: true, // holding J/L scrubs, like video editors
      isEnabled: hasAudio,
      run: (ctx) => ctx.jumpBack(),
    },
    {
      id: "transport.jumpForward",
      title: ja.commands.jumpForward,
      section: "transport",
      shortcuts: ["L"],
      allowRepeat: true,
      isEnabled: hasAudio,
      run: (ctx) => ctx.jumpForward(),
    },
    {
      id: "transport.seekStart",
      title: ja.commands.seekStart,
      section: "transport",
      shortcuts: ["Home"],
      isEnabled: hasAudio,
      run: (ctx) => ctx.seekToStart(),
    },
    {
      id: "transport.seekEnd",
      title: ja.commands.seekEnd,
      section: "transport",
      shortcuts: ["End"],
      isEnabled: hasAudio,
      run: (ctx) => ctx.seekToEnd(),
    },
    {
      id: "transport.toggleLoop",
      title: ja.commands.toggleLoop,
      section: "transport",
      shortcuts: ["Ctrl+L"],
      isEnabled: hasAudio,
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
      isEnabled: (s) => s.hasScore && s.reviewCount > 0,
      isVisible: (s) => s.hasScore && s.reviewCount > 0,
      run: (ctx) => ctx.openReview(),
    },
    {
      id: "review.next",
      title: ja.commands.reviewNext,
      section: "review",
      // §12 header has a 次へ button too — the arrow keys keep review
      // processing menu-free (acceptance: 20 items without menus).
      shortcuts: ["ArrowRight"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewNext(),
    },
    {
      id: "review.previous",
      title: ja.commands.reviewPrevious,
      section: "review",
      shortcuts: ["ArrowLeft"],
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
      id: "review.pitchUp",
      title: ja.commands.reviewPitchUp,
      section: "review",
      shortcuts: ["Alt+ArrowUp"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPitchUp?.(),
    },
    {
      id: "review.pitchDown",
      title: ja.commands.reviewPitchDown,
      section: "review",
      shortcuts: ["Alt+ArrowDown"],
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPitchDown?.(),
    },
    {
      id: "review.deleteOrRestore",
      title: ja.commands.reviewDeleteOrRestore,
      section: "review",
      shortcuts: ["Delete", "Backspace"],
      isEnabled: (s) => s.reviewOpen,
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
      // selected (e.g. all issues resolved).
      isEnabled: (s) => s.hasSelection || s.reviewOpen,
      run: (ctx) => ctx.clearSelection(),
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

    // ---- project save (#100) ----
    {
      id: "project.save",
      title: ja.commands.saveProject,
      section: "file",
      shortcuts: ["Ctrl+S"],
      isEnabled: (s) => s.hasScore && !s.isTranscribing,
      run: (ctx) => ctx.saveProject?.(),
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
  ];
}
