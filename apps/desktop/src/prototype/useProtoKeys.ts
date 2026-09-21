import { useEffect } from "react";

/**
 * UI-009 prototype key map — the single place prototype pages bind keys,
 * mirroring the spirit of the §23 command registry (no scattered ad-hoc
 * handlers). Keys are matched against a normalized combo string such as
 * "Space", "Ctrl+1", "Alt+ArrowUp", "j", "Escape".
 *
 * Text-entry targets are skipped so keys never fight Japanese IME input.
 */

export interface KeyBinding {
  combo: string;
  run(): void;
  /** When set, the binding only fires while `enabled()` is true. */
  enabled?(): boolean;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key === " " ? "Space" : e.key;
  parts.push(key.length === 1 ? key.toLowerCase() : key);
  return parts.join("+");
}

export function useProtoKeys(bindings: KeyBinding[]): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const combo = comboOf(e);
      for (const b of bindings) {
        if (b.combo !== combo) continue;
        if (b.enabled && !b.enabled()) return;
        e.preventDefault();
        b.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
}
