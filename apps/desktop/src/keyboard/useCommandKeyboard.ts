/**
 * React wiring for the KeyboardDispatcher (GUI_UX_SPEC §23).
 *
 * The app installs exactly one window-level keydown listener through this
 * hook — the "no ad-hoc component key handlers" rule is enforced by giving
 * components no reason to have one.
 */

import { useEffect } from "react";
import type { KeyboardDispatcher } from "./dispatcher";

export function useCommandKeyboard(
  dispatcher: KeyboardDispatcher | null,
): void {
  useEffect(() => {
    if (!dispatcher) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const result = dispatcher.handleKeyDown(e);
      if (result.shouldPreventDefault) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatcher]);
}
