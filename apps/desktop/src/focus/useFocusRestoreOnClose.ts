/**
 * useFocusRestoreOnClose — wires FocusRestorer to a surface's open state
 * (GUI_UX_SPEC §22: "dialog close restores opener focus").
 *
 * Usage: call with the same `open` value passed to HsDialog / HsSheet /
 * HsPopover. On open the focused element is captured; on close (or unmount
 * while open) focus returns to it — but only if focus would otherwise be
 * stranded on <body>, so deliberate focus moves are never overridden and
 * Fluent's own trigger-restore keeps precedence.
 */

import { useEffect } from "react";
import { createFocusRestorer } from "./focusRestore";

export function useFocusRestoreOnClose(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const restorer = createFocusRestorer();
    restorer.capture();
    return () => {
      // The closing surface has just unmounted (cleanup runs after the
      // commit). If it had exit animation that kept it mounted, a deferred
      // pass catches the eventual stranded focus too — the second call is
      // a no-op once the first restored (or intentionally skipped).
      restorer.restore();
      window.setTimeout(() => restorer.restore(), 0);
    };
  }, [open]);
}
