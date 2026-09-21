/**
 * Focus restoration (GUI_UX_SPEC §22, issue UI-012).
 *
 * "dialog close restores opener focus" — the restorer captures the element
 * that had focus when a surface opened and gives focus back when it closes.
 * Restoration only fires when focus is stranded (active element is the body
 * or a detached node), so it never yanks focus away from somewhere the user
 * deliberately moved it, and never fights Fluent's own trigger-restore.
 *
 * `createFocusRestorer` takes a Document so tests can run it against jsdom
 * without globals; the React hook wires it to surface open state.
 */

export interface FocusRestorer {
  /** Remembers the element that holds focus right now. */
  capture(): void;
  /**
   * Focuses the captured element when focus is currently stranded
   * (document.body / detached node). Returns true when focus moved.
   * `force` skips the stranded check — used by tests and explicit flows.
   */
  restore(options?: { force?: boolean }): boolean;
  /** Drops the saved reference without restoring. */
  clear(): void;
  /** The captured element (mostly for tests/diagnostics). */
  readonly captured: Element | null;
}

function isFocusable(el: Element): el is HTMLElement {
  return typeof (el as HTMLElement).focus === "function";
}

export function createFocusRestorer(doc: Document = document): FocusRestorer {
  let saved: Element | null = null;
  return {
    capture() {
      const active = doc.activeElement;
      // Never capture <body> itself — restoring "to body" is meaningless.
      saved = active && active !== doc.body ? active : null;
    },
    restore({ force = false } = {}) {
      if (!saved || !isFocusable(saved)) return false;
      if (!saved.isConnected) {
        // Opener is gone — nothing sensible to return focus to.
        saved = null;
        return false;
      }
      const active = doc.activeElement;
      const stranded =
        force ||
        active == null ||
        active === doc.body ||
        !active.isConnected;
      if (!stranded) {
        // Focus already lives somewhere real — don't steal it back.
        saved = null;
        return false;
      }
      const target = saved;
      saved = null;
      target.focus();
      return doc.activeElement === target;
    },
    clear() {
      saved = null;
    },
    get captured() {
      return saved;
    },
  };
}
