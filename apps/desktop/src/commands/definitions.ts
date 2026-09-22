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
      run: (ctx) => ctx.openAudio(),
    },

    // ---- score ----
    {
      id: "score.transcribe",
      title: ja.commands.transcribe,
      section: "score",
      // §5: rewriting the canonical score mid-transcription is forbidden.
      isEnabled: (s) => s.hasAudio && !s.isTranscribing,
      run: (ctx) => ctx.transcribe(),
    },
    {
      id: "score.retranscribe",
      title: ja.commands.retranscribe,
      section: "score",
      // Same action as 採譜 once a score exists; the command bar relabels.
      isEnabled: (s) => s.hasScore && !s.isTranscribing,
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

    // ---- review (§12) ----
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
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewNext(),
    },
    {
      id: "review.previous",
      title: ja.commands.reviewPrevious,
      section: "review",
      isEnabled: (s) => s.reviewOpen,
      isVisible: (s) => s.reviewOpen,
      run: (ctx) => ctx.reviewPrevious(),
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
      isEnabled: (s) => s.hasSelection,
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
