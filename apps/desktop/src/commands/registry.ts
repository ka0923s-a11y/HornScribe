/**
 * Keyboard command registry (docs/GUI_UX_SPEC.md §23).
 *
 * All shortcuts are defined in this single place; components must not
 * register their own ad-hoc keydown handlers for app commands.
 */

export interface CommandContext {
  setPitchView(view: "concert" | "hornF"): void;
  openAudioRequested(): void;
  openSettings(): void;
}

export interface Command {
  id: string;
  /** Japanese label shown in UI / tooltips. */
  labelJa: string;
  /** e.g. "Ctrl+1" — matched case-insensitively on KeyboardEvent. */
  shortcut?: string;
  isEnabled(): boolean;
  execute(ctx: CommandContext): void;
}

export interface ShellState {
  hasAudio: boolean;
  hasScore: boolean;
  reviewCount: number;
}

export function createCommands(state: ShellState): Command[] {
  return [
    {
      id: "file.openAudio",
      labelJa: "音声ファイルを開く",
      shortcut: "Ctrl+O",
      isEnabled: () => true,
      execute: (ctx) => ctx.openAudioRequested(),
    },
    {
      id: "score.transcribe",
      labelJa: "採譜",
      isEnabled: () => state.hasAudio,
      execute: () => undefined, // spike: transcription engine not wired yet
    },
    {
      id: "view.concertPitch",
      labelJa: "コンサートピッチ",
      shortcut: "Ctrl+1",
      isEnabled: () => true,
      execute: (ctx) => ctx.setPitchView("concert"),
    },
    {
      id: "view.hornF",
      labelJa: "F管ホルン",
      shortcut: "Ctrl+2",
      isEnabled: () => true,
      execute: (ctx) => ctx.setPitchView("hornF"),
    },
    {
      id: "review.open",
      labelJa: "要確認",
      isEnabled: () => state.hasScore && state.reviewCount > 0,
      execute: () => undefined,
    },
    {
      id: "export.open",
      labelJa: "書き出し",
      isEnabled: () => state.hasScore,
      execute: () => undefined,
    },
    {
      id: "app.settings",
      labelJa: "設定",
      isEnabled: () => true,
      execute: (ctx) => ctx.openSettings(),
    },
  ];
}

/** Match a KeyboardEvent against "Ctrl+1" style shortcut strings. */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  const wantCtrl = parts.includes("Ctrl");
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  return (
    e.key.toLowerCase() === key &&
    e.ctrlKey === wantCtrl &&
    e.shiftKey === wantShift &&
    e.altKey === wantAlt
  );
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * Central keydown dispatcher. Text-entry contexts are left alone so
 * shortcuts never fight Japanese IME input (MASTER_PLAN §8).
 */
export function dispatchCommand(
  e: KeyboardEvent,
  commands: Command[],
  ctx: CommandContext,
): boolean {
  if (isTextEntryTarget(e.target)) return false;
  for (const cmd of commands) {
    if (cmd.shortcut && matchesShortcut(e, cmd.shortcut)) {
      if (!cmd.isEnabled()) return true; // swallow: shortcut known but disabled
      cmd.execute(ctx);
      return true;
    }
  }
  return false;
}
