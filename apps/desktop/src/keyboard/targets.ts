/**
 * Keyboard target classification (docs/GUI_UX_SPEC.md §9, §22, §23).
 *
 * Decides, for a given event target, which commands are eligible:
 * - text-entry targets (input/textarea/contenteditable) suppress shortcuts —
 *   Japanese IME composition and plain typing must never trigger commands;
 * - modal surfaces (dialog / alertdialog / drawer) suppress everything —
 *   the surface owns the keyboard until it closes;
 * - interactive controls "consume" the keys their role needs (a focused
 *   button owns Space/Enter; a slider owns arrows/Home/End), so global
 *   single-key commands don't fight built-in control behavior.
 *
 * All predicates take `EventTarget | null` and degrade to "not scoped"
 * for non-element targets so the dispatcher is testable with stubs.
 */

import type { KeyChord } from "./keys";

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  // Support event targets like window/document — never scoped.
  if (target instanceof Document) return target.documentElement;
  return null;
}

/** INPUT types that accept free text (IME-relevant). */
const TEXT_INPUT_TYPES = new Set([
  "", // default type
  "text",
  "search",
  "url",
  "tel",
  "password",
  "email",
  "number",
]);

/**
 * True when the event originates in a free-text editing context where all
 * app shortcuts are suppressed unless the command opts in via
 * `allowInTextInput` (MASTER_PLAN §8 / UI_COPY_CONTRACT IME requirement).
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  // Editing hosts nested inside a text field (e.g. a clear button rendered
  // inside an input wrapper is still an editing context for our purposes —
  // the closest() check keeps events from inner decoration scoped).
  return el.closest("input, textarea, [contenteditable='true']") !== null;
}

/**
 * True when the event originates inside a modal surface that owns focus
 * (Fluent Dialog/alertdialog, OverlayDrawer which renders role="dialog",
 * or any element explicitly marked `data-hs-modal`). Commands are
 * suppressed unless they set `allowInModal` — Escape/Tab/Enter are left to
 * the surface itself.
 */
export function isModalTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  return (
    el.closest('[role="dialog"], [role="alertdialog"], [data-hs-modal]') !==
    null
  );
}

/**
 * Keys consumed by the interactive control under the target, so the
 * dispatcher can leave them alone. Roles/tags are matched via closest() so
 * inner markup (icons inside a button) still resolves to its control.
 */
const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "select",
  "summary",
  "input",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="treeitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="scrollbar"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(", ");

/** Printable-key check: one character (letter/digit/punct) or space. */
function isPrintableChord(chord: KeyChord): boolean {
  if (chord.ctrl || chord.alt) return false;
  return chord.key.length === 1 || chord.key === "space";
}

const NAVIGATION_KEYS = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/**
 * True when the interactive control under `target` owns this chord, so the
 * global dispatcher must not run a command bound to it.
 *
 * Examples: Space on a focused button activates the button (not
 * play/pause); arrows inside a radiogroup move selection; typeahead keys on
 * a select jump to options. Ctrl-modified chords are never consumed by
 * native controls here, so Ctrl-based commands keep working when a control
 * has focus.
 */
export function controlConsumesChord(
  target: EventTarget | null,
  chord: KeyChord,
): boolean {
  const el = asElement(target);
  if (!el) return false;
  const control = el.closest(CONTROL_SELECTOR);
  if (!control) return false;

  const role = control.getAttribute("role");
  const tag = control.tagName.toLowerCase();
  const kind =
    role ??
    (tag === "input"
      ? `input-${(control.getAttribute("type") ?? "text").toLowerCase()}`
      : tag);

  const activation = chord.key === "enter" || chord.key === "space";
  const navigation = NAVIGATION_KEYS.has(chord.key);
  const printable = isPrintableChord(chord);

  switch (kind) {
    // Activatables consume Space/Enter so global Space never fires while a
    // button/menu item/link/tab is focused.
    case "button":
    case "a":
    case "summary":
    case "link":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "option":
    case "treeitem":
    case "tab":
    case "input-button":
    case "input-submit":
    case "input-reset":
    case "input-image":
      return activation && !chord.ctrl && !chord.alt;
    // Toggle controls consume Space only (Enter is not an activator).
    case "checkbox":
    case "radio":
    case "switch":
    case "input-checkbox":
    case "input-radio":
      return chord.key === "space" && !chord.ctrl && !chord.alt;
    // Value widgets own arrow/Home/End/PageUp/PageDown for adjustment.
    case "slider":
    case "spinbutton":
    case "scrollbar":
    case "input-range":
      return navigation && !chord.ctrl && !chord.alt;
    // Pickers consume activation, navigation, typeahead printables, and
    // Escape (closing their popup) so nothing double-handles.
    case "select":
    case "combobox":
    case "listbox":
    case "menu":
      return (
        (activation || navigation || printable || chord.key === "escape") &&
        !chord.ctrl &&
        !chord.alt
      );
    default:
      return activation && !chord.ctrl && !chord.alt;
  }
}
