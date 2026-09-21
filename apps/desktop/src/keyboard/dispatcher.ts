/**
 * Central keyboard dispatcher (docs/GUI_UX_SPEC.md §9, §22, §23).
 *
 * One dispatcher per app; a single `keydown` listener at the window level
 * feeds it. Components do not register their own command shortcuts.
 *
 * Guarantees:
 * - IME safety: events during composition (`isComposing`, keyCode 229) are
 *   ignored, so Japanese input never triggers commands.
 * - Text-entry safety: inside text fields only commands that opt in via
 *   `allowInTextInput` are considered (J/K/L stay disabled while typing).
 * - Control cooperation: keys a focused control owns (Space on a button,
 *   arrows on a slider, typeahead on a select) are left to the control.
 * - Modal safety: while a dialog/drawer owns focus, only `allowInModal`
 *   commands are considered.
 * - Disabled commands are still swallowed (the event is consumed but the
 *   command does not run) so a known-but-disabled shortcut is inert rather
 *   than falling through to browser defaults like Ctrl+O.
 * - Chord sequences: multi-chord bindings ("Ctrl+K Ctrl+C") hold a pending
 *   prefix for `sequenceTimeoutMs`.
 */

import {
  chordFromEvent,
  isSequencePrefix,
  type KeyChord,
  type KeyEventLike,
} from "./keys";
import {
  controlConsumesChord,
  isModalTarget,
  isTextEntryTarget,
} from "./targets";
import type {
  Command,
  CommandContext,
  CommandSnapshot,
} from "../commands/types";
import type { CommandRegistry } from "../commands/registry";

export type DispatchKind =
  /** Event ran a command. */
  | "ran"
  /** Known shortcut, command currently disabled — consumed, not run. */
  | "disabled"
  /** Event extends a pending multi-chord sequence — consumed. */
  | "sequence-pending"
  /** Key auto-repeat for a non-repeatable command — consumed, not run. */
  | "repeat"
  /** Suppressed by scope (IME / text input / modal / owning control). */
  | "suppressed"
  /** No binding matched. */
  | "unmatched";

export interface DispatchResult {
  readonly kind: DispatchKind;
  readonly commandId?: string;
  /** Whether the host should call preventDefault() on the event. */
  readonly shouldPreventDefault: boolean;
}

export interface KeyboardDispatcherOptions {
  readonly registry: CommandRegistry;
  /** Latest app-state snapshot — read lazily per event. */
  readonly getSnapshot: () => CommandSnapshot;
  /** Live services commands act on. */
  readonly context: CommandContext;
  /** Pending multi-chord sequence timeout (default 1000ms). */
  readonly sequenceTimeoutMs?: number;
  /** Clock injection for tests (default Date.now). */
  readonly now?: () => number;
}

interface PendingSequence {
  chords: KeyChord[];
  at: number;
}

const RAN: DispatchResult = { kind: "ran", shouldPreventDefault: true };
const IGNORED: DispatchResult = { kind: "suppressed", shouldPreventDefault: false };
const UNMATCHED: DispatchResult = { kind: "unmatched", shouldPreventDefault: false };

export class KeyboardDispatcher {
  private readonly options: KeyboardDispatcherOptions;
  private pending: PendingSequence | null = null;

  constructor(options: KeyboardDispatcherOptions) {
    this.options = options;
  }

  /** Drops any pending multi-chord prefix (e.g. on blur). */
  resetPending(): void {
    this.pending = null;
  }

  /**
   * Handles one keydown event. The caller preventDefaults when
   * `result.shouldPreventDefault` is true.
   */
  handleKeyDown(e: KeyEventLike): DispatchResult {
    // 1. IME composition in progress — never dispatch (UI_COPY_CONTRACT).
    if (e.isComposing || e.keyCode === 229) return IGNORED;

    const chord = chordFromEvent(e);

    // 2. Scope resolution: modal > text-entry > workspace.
    const inModal = isModalTarget(e.target ?? null);
    const inTextInput = !inModal && isTextEntryTarget(e.target ?? null);

    // 3. Chords the focused control owns are left alone (Space on a button
    //    etc.). Ctrl/Alt chords are never consumed by native controls.
    if (
      !inModal &&
      !inTextInput &&
      controlConsumesChord(e.target ?? null, chord)
    ) {
      return IGNORED;
    }

    // 4. Candidate bindings filtered by scope.
    const eligible = this.options.registry.bindings().filter(({ command }) => {
      if (inModal) return command.allowInModal === true;
      if (inTextInput) return command.allowInTextInput === true;
      return true;
    });

    const now = (this.options.now ?? Date.now)();
    const timeoutMs = this.options.sequenceTimeoutMs ?? 1000;
    if (this.pending && now - this.pending.at > timeoutMs) {
      this.pending = null; // stale prefix expired
    }

    // Matches `events` against eligible bindings: a "full" match runs, a
    // "partial" one means the events are a strict prefix of a longer
    // sequence and should be held as pending.
    const tryMatch = (
      events: readonly KeyChord[],
    ): { type: "full"; command: Command } | { type: "partial" } | null => {
      for (const { command, sequence } of eligible) {
        if (
          sequence.length === events.length &&
          isSequencePrefix(events, sequence)
        ) {
          return { type: "full", command };
        }
      }
      for (const { sequence } of eligible) {
        if (
          sequence.length > events.length &&
          isSequencePrefix(events, sequence)
        ) {
          return { type: "partial" };
        }
      }
      return null;
    };

    const hadPending = this.pending !== null;
    const match = tryMatch([...(this.pending?.chords ?? []), chord]);
    if (match?.type === "full") {
      this.pending = null;
      return this.activate(match.command, e);
    }
    if (match?.type === "partial") {
      this.pending = {
        chords: [...(this.pending?.chords ?? []), chord],
        at: now,
      };
      return { kind: "sequence-pending", shouldPreventDefault: true };
    }

    // Dead sequence (or none): retry this event on its own — it may still
    // complete a single-chord binding or open a fresh sequence prefix.
    this.pending = null;
    if (hadPending) {
      const retry = tryMatch([chord]);
      if (retry?.type === "full") return this.activate(retry.command, e);
      if (retry?.type === "partial") {
        this.pending = { chords: [chord], at: now };
        return { kind: "sequence-pending", shouldPreventDefault: true };
      }
    }
    // Scope-restricted events that matched nothing were actively suppressed
    // (the binding may exist but is not eligible here); outside restricted
    // scopes a miss is simply an unbound key.
    return inModal || inTextInput ? IGNORED : UNMATCHED;
  }

  private activate(command: Command, e: KeyEventLike): DispatchResult {
    // Held-key auto-repeat only re-runs commands that opt in.
    if (e.repeat === true && command.allowRepeat !== true) {
      return {
        kind: "repeat",
        commandId: command.id,
        shouldPreventDefault: true,
      };
    }
    const snapshot = this.options.getSnapshot();
    if (!(command.isEnabled?.(snapshot) ?? true)) {
      // Known shortcut, currently disabled: consume the event so the
      // binding is inert rather than leaking to the browser (issue req:
      // "disabled commands remain non-executable via shortcut").
      return {
        kind: "disabled",
        commandId: command.id,
        shouldPreventDefault: true,
      };
    }
    command.run(this.options.context, snapshot);
    return { ...RAN, commandId: command.id };
  }
}
