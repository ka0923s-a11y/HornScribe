/**
 * Command registry (docs/GUI_UX_SPEC.md §23) — the single source of truth
 * for every invocable action in the app.
 *
 * - Command bar buttons, menus, a future command palette and the keyboard
 *   dispatcher all go through this registry; components never own ad-hoc
 *   keydown handlers for app commands.
 * - Commands are stateless definitions; `isEnabled`/`isVisible` predicates
 *   evaluate against an immutable CommandSnapshot the app rebuilds per
 *   render, so enabled state is always consistent across every surface.
 * - `detectConflicts` catches duplicate bindings at construction time —
 *   see registry.test.ts which asserts the shipped set is conflict-free.
 */

import { parseShortcut, sequenceKey, type KeySequence } from "../keyboard/keys";
import { createCommandDefinitions } from "./definitions";
import type { Command, CommandContext, CommandSnapshot } from "./types";

export type { Command, CommandContext, CommandSnapshot } from "./types";

/** One registered binding: which command owns a parsed sequence. */
export interface CommandBinding {
  readonly command: Command;
  /** The original shortcut string ("Ctrl+Shift+Z"). */
  readonly shortcut: string;
  /** Parsed chord sequence (single chord for all current bindings). */
  readonly sequence: KeySequence;
}

/** A detected shortcut collision between two commands. */
export interface ShortcutConflict {
  readonly shortcut: string;
  readonly commandIds: readonly string[];
}

export class CommandRegistry {
  private readonly byId = new Map<string, Command>();
  private readonly bindingList: CommandBinding[] = [];

  constructor(commands: readonly Command[] = []) {
    for (const command of commands) this.register(command);
  }

  /**
   * Registers a command. Throws on duplicate id — a second registration for
   * an id is always a bug (use a new id or unregister first).
   */
  register(command: Command): void {
    if (this.byId.has(command.id)) {
      throw new Error(`Duplicate command id: "${command.id}"`);
    }
    this.byId.set(command.id, command);
    for (const shortcut of command.shortcuts ?? []) {
      this.bindingList.push({
        command,
        shortcut,
        sequence: parseShortcut(shortcut),
      });
    }
  }

  unregister(id: string): boolean {
    if (!this.byId.delete(id)) return false;
    for (let i = this.bindingList.length - 1; i >= 0; i--) {
      if (this.bindingList[i].command.id === id) this.bindingList.splice(i, 1);
    }
    return true;
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  /** All registered commands in registration order. */
  list(): readonly Command[] {
    return [...this.byId.values()];
  }

  /** Commands currently listed on command surfaces (menus/palette). */
  listVisible(snapshot: CommandSnapshot): readonly Command[] {
    return this.list().filter((c) => c.isVisible?.(snapshot) ?? true);
  }

  isEnabled(id: string, snapshot: CommandSnapshot): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    return command.isEnabled?.(snapshot) ?? true;
  }

  isVisible(id: string, snapshot: CommandSnapshot): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    return command.isVisible?.(snapshot) ?? true;
  }

  /** Canonical display shortcut (first binding), e.g. "Ctrl+O". */
  shortcutLabel(id: string): string | undefined {
    return this.byId.get(id)?.shortcuts?.[0];
  }

  /**
   * All parsed bindings — consumed by the keyboard dispatcher and by
   * conflict detection. Same normalized sequence under two commands with
   * overlapping scopes is a conflict.
   */
  bindings(): readonly CommandBinding[] {
    return this.bindingList;
  }

  /**
   * Invoke a command by id — the path used by buttons, menus and palette
   * items. Returns false (running nothing) when the command is unknown or
   * disabled, so a disabled command is non-executable from every surface.
   */
  invoke(
    id: string,
    ctx: CommandContext,
    snapshot: CommandSnapshot,
  ): boolean {
    const command = this.byId.get(id);
    if (!command) return false;
    if (!(command.isEnabled?.(snapshot) ?? true)) return false;
    command.run(ctx, snapshot);
    return true;
  }

  /**
   * Finds duplicate normalized bindings. Two commands binding the same
   * chord sequence is always a conflict — all commands share the workspace
   * scope, so overlapping `isEnabled` predicates cannot rescue it.
   */
  detectConflicts(): ShortcutConflict[] {
    const bySequence = new Map<string, Command[]>();
    for (const binding of this.bindingList) {
      const key = sequenceKey(binding.sequence);
      const list = bySequence.get(key) ?? [];
      list.push(binding.command);
      bySequence.set(key, list);
    }
    const conflicts: ShortcutConflict[] = [];
    for (const [shortcut, cmds] of bySequence) {
      // #114: a shared chord is legal only when EVERY command on it opts
      // in via `shareShortcut` - the dispatcher then picks the first
      // enabled candidate. An unflagged sharer is a real conflict.
      if (cmds.length > 1 && cmds.some((c) => c.shareShortcut !== true)) {
        conflicts.push({
          shortcut,
          commandIds: cmds.map((c) => c.id),
        });
      }
    }
    return conflicts;
  }
}

/**
 * Render-scoped view of the registry for components. Bound to one snapshot
 * so every surface (command bar, transport, menus) agrees on enabled state
 * within a render; `invoke` routes through the same predicates as keyboard
 * dispatch, so a disabled command is non-executable everywhere.
 */
export interface CommandSurface {
  /** Runs the command when enabled; returns whether it ran. */
  invoke(id: string): boolean;
  isEnabled(id: string): boolean;
  isVisible(id: string): boolean;
  /** Japanese title for buttons/menus ("" when the id is unknown). */
  title(id: string): string;
  /** Canonical display shortcut, e.g. "Ctrl+O". */
  shortcutLabel(id: string): string | undefined;
}

export function createCommandSurface(
  registry: CommandRegistry,
  ctx: CommandContext,
  snapshot: CommandSnapshot,
): CommandSurface {
  return {
    invoke: (id) => registry.invoke(id, ctx, snapshot),
    isEnabled: (id) => registry.isEnabled(id, snapshot),
    isVisible: (id) => registry.isVisible(id, snapshot),
    title: (id) => registry.get(id)?.title ?? "",
    shortcutLabel: (id) => registry.shortcutLabel(id),
  };
}

/**
 * Builds the app registry from the built-in definitions and fails fast on
 * shortcut conflicts — a conflicting registration must never ship silently.
 */
export function createCommandRegistry(
  commands: readonly Command[] = createCommandDefinitions(),
): CommandRegistry {
  const registry = new CommandRegistry(commands);
  const conflicts = registry.detectConflicts();
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `${c.shortcut}: ${c.commandIds.join(", ")}`)
      .join("; ");
    throw new Error(`Shortcut conflicts in command registry: ${detail}`);
  }
  return registry;
}
