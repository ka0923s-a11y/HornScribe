/**
 * Keyboard chord model (docs/GUI_UX_SPEC.md §23).
 *
 * A `KeyChord` is one physical key press plus its modifiers ("Ctrl+Shift+Z",
 * "F6", "Space"). A `KeySequence` is an ordered list of chords so the
 * registry can express multi-step bindings ("Ctrl+K Ctrl+C") even though the
 * initial shortcut table only uses single chords.
 *
 * This module is pure: it has no DOM, React, or command-registry dependency
 * so it can be unit-tested in isolation and reused by any dispatcher.
 */

/**
 * Minimal structural view of a keyboard event. `KeyboardEvent` satisfies
 * this interface, and tests can build plain objects without a DOM.
 */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey?: boolean;
  /** True while an IME composition is in progress (`keydown` only). */
  readonly isComposing?: boolean;
  /** Legacy but still the reliable IME sentinel: 229 during composition. */
  readonly keyCode?: number;
  readonly repeat?: boolean;
  readonly target?: EventTarget | null;
}

export interface KeyChord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Normalized key name: lowercase, "space" for " ". See normalizeKey. */
  readonly key: string;
}

/** An ordered chord sequence; a single chord is the common case. */
export type KeySequence = readonly KeyChord[];

/**
 * Characters whose glyph already encodes Shift on US/JIS layouts. When the
 * event key is one of these, a binding that spells the glyph directly
 * ("Ctrl++") must not require the shift flags to be equal — pressing "+"
 * physically requires Shift, so `Ctrl+Shift+=` arrives as Ctrl+Shift+"+".
 */
const SHIFT_IMPLICIT_KEYS = new Set([
  "+",
  "_",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "{",
  "}",
  "|",
  ":",
  '"',
  "<",
  ">",
  "?",
  "~",
]);

/**
 * Normalizes `KeyboardEvent.key` / shortcut string key parts into the
 * canonical form used inside KeyChord. Single characters lowercase;
 * whitespace variants collapse to "space".
 */
export function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return "space"; // KeyboardEvent.key === " "
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case "spacebar": // pre-standard name
    case "space":
      return "space";
    case "esc":
      return "escape";
    case "del":
      return "delete";
    case "return":
      return "enter";
    case "arrowup":
    case "arrowdown":
    case "arrowleft":
    case "arrowright":
      return lower;
    default:
      return lower;
  }
}

/** Display name for a normalized key ("space"→"Space", "f6"→"F6"). */
export function displayKey(key: string): string {
  if (key === "space") return "Space";
  if (key === "escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  // "arrowleft" → "ArrowLeft", "f6" → "F6", "pageup" → "PageUp"
  const special: Record<string, string> = {
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    delete: "Delete",
    backspace: "Backspace",
    enter: "Enter",
    tab: "Tab",
    insert: "Insert",
  };
  return special[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

const MODIFIERS: Record<string, "ctrl" | "shift" | "alt" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  win: "meta",
};

/**
 * Parses one chord string like "Ctrl+Shift+Z", "F6" or "Space".
 * The key is the last "+"-separated part; a trailing "+" means the key
 * itself is "+" (so "Ctrl++" parses as Ctrl + "+").
 *
 * HornScribe is Windows-first; Meta is parsed for completeness but no
 * built-in binding uses it.
 */
export function parseChord(text: string): KeyChord {
  const parts = text.trim().split("+");
  let keyPart = parts.pop() ?? "";
  if (keyPart === "" && parts.length > 0) {
    // Trailing "+": the key is literally "+".
    keyPart = "+";
    parts.pop(); // drop the empty segment left behind
  }
  if (keyPart === "" || parts.some((p) => p.trim() === "")) {
    throw new Error(`Invalid chord: "${text}"`);
  }
  if (MODIFIERS[keyPart.trim().toLowerCase()] !== undefined) {
    throw new Error(`Chord "${text}" has a modifier as its key`);
  }
  let ctrl = false;
  let shift = false;
  let alt = false;
  for (const part of parts) {
    const mod = MODIFIERS[part.trim().toLowerCase()];
    if (!mod) {
      throw new Error(`Invalid modifier "${part}" in chord "${text}"`);
    }
    if (mod === "ctrl") ctrl = true;
    else if (mod === "shift") shift = true;
    else if (mod === "alt") alt = true;
    // meta is accepted but unused by built-in bindings (Windows-first app)
  }
  return { ctrl, shift, alt, key: normalizeKey(keyPart) };
}

/**
 * Parses a full shortcut string into a chord sequence. Chords are separated
 * by whitespace, so the space bar must be spelled "Space" ("Ctrl+Space",
 * never a literal " " inside a sequence).
 */
export function parseShortcut(text: string): KeySequence {
  const chords = text
    .trim()
    .split(/\s+/)
    .map(parseChord);
  if (chords.length === 0) throw new Error(`Invalid shortcut: "${text}"`);
  return chords;
}

/** Builds the chord a physical key event represents. */
export function chordFromEvent(e: KeyEventLike): KeyChord {
  return {
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: normalizeKey(e.key),
  };
}

/**
 * True when a physical chord event satisfies a bound chord.
 * Modifier equality is strict except for shift on SHIFT_IMPLICIT_KEYS —
 * "+" can only be produced with Shift held, so "Ctrl++" must match the
 * real Ctrl+Shift+"+" event (GUI_UX_SPEC §15 zoom keys).
 */
export function chordSatisfiedBy(chord: KeyChord, event: KeyChord): boolean {
  if (chord.key !== event.key) return false;
  if (chord.ctrl !== event.ctrl) return false;
  if (chord.alt !== event.alt) return false;
  if (chord.shift === event.shift) return true;
  return SHIFT_IMPLICIT_KEYS.has(chord.key);
}

export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt
  );
}

/** Canonical "Ctrl+Shift+Z" rendering of a chord (for UI + conflict keys). */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  parts.push(displayKey(chord.key));
  return parts.join("+");
}

/** Canonical rendering of a sequence: chords joined by a single space. */
export function formatSequence(sequence: KeySequence): string {
  return sequence.map(formatChord).join(" ");
}

/**
 * Stable string key for a sequence — used by conflict detection so that
 * "Ctrl+shift+z" and "Ctrl+Shift+Z" are recognized as the same binding.
 */
export function sequenceKey(sequence: KeySequence): string {
  return formatSequence(sequence);
}

/**
 * True when the pressed `events` satisfy a leading prefix of the bound
 * `sequence` (or the whole sequence when lengths are equal). Uses
 * chordSatisfiedBy so shift-implicit symbols ("+") match correctly.
 */
export function isSequencePrefix(
  events: readonly KeyChord[],
  sequence: KeySequence,
): boolean {
  if (events.length > sequence.length) return false;
  return events.every((event, i) => chordSatisfiedBy(sequence[i], event));
}
