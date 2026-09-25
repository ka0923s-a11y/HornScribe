/**
 * #406: コマンドパレット (Ctrl+K) — fuzzy-launch over the live registry.
 *
 * Same non-modal role="dialog" + roaming aria-activedescendant pattern
 * as ReviewNavigator (#361): focus stays on the search input (an ARIA
 * combobox), ArrowUp/Down/Home/End roam the option list, Enter invokes
 * the active command, Esc closes. The dialog scope keeps the global
 * dispatcher out of the keys (isModalTarget); the Ctrl+K command opts
 * back in via allowInModal + allowInTextInput so a second press closes
 * the palette again.
 *
 * The option list is registry.listVisible(snapshot) — the same
 * predicate the menus, command bar and keyboard dispatcher evaluate —
 * substring-filtered over the Japanese title, dotted id and optional
 * description. Disabled commands stay listed (dimmed, aria-disabled)
 * so the palette answers "why can't I run X right now" instead of
 * hiding them silently; invoking a disabled row is a no-op, same as a
 * dimmed menu item.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ja } from "../strings/ja";
import type { Command } from "../commands/types";

export interface CommandPaletteProps {
  /** Registry commands already filtered by isVisible(snapshot). */
  commands: readonly Command[];
  isEnabled(id: string): boolean;
  /** Invoke through the registry surface — the same gate that buttons,
   *  menus and shortcuts go through, so a disabled command cannot run. */
  invoke(id: string): boolean;
  onClose(): void;
}

const SECTION_ORDER = [
  "file",
  "score",
  "transport",
  "view",
  "review",
  "edit",
  "export",
  "nav",
  "app",
] as const;

function sectionLabel(section: string): string {
  const map = ja.shortcutsHelp.sections as Record<string, string>;
  return map[section] ?? section;
}

function matches(cmd: Command, q: string): boolean {
  if (!q) return true;
  return (
    cmd.title.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    (cmd.description ?? "").toLowerCase().includes(q)
  );
}

interface Listed {
  readonly cmd: Command;
  readonly section: string;
}

export function CommandPalette({
  commands,
  isEnabled,
  invoke,
  onClose,
}: CommandPaletteProps) {
  const t = ja.commandPalette;
  const [query, setQuery] = useState("");
  const [focusPos, setFocusPos] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo<Listed[]>(() => {
    const q = query.trim().toLowerCase();
    // Section grouping keeps the browse-all (empty query) list scannable;
    // matches keep registration order inside each section.
    const bySection = new Map<string, Command[]>();
    for (const c of commands) {
      if (!matches(c, q)) continue;
      const group = bySection.get(c.section) ?? [];
      group.push(c);
      bySection.set(c.section, group);
    }
    const out: Listed[] = [];
    for (const section of SECTION_ORDER) {
      for (const cmd of bySection.get(section) ?? []) {
        out.push({ cmd, section });
      }
    }
    return out;
  }, [commands, query]);

  const pos = Math.min(focusPos, Math.max(0, filtered.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-pos=\"" + pos + "\"]")
      ?.scrollIntoView({ block: "nearest" });
  }, [pos]);

  const run = (index: number) => {
    const entry = filtered[index];
    if (!entry || !isEnabled(entry.cmd.id)) return;
    onClose();
    invoke(entry.cmd.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Close the palette only — the modal scope keeps the dispatcher
      // from also running a global Escape command behind us.
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const n = filtered.length;
    if (n === 0) return;
    let next = pos;
    if (e.key === "ArrowDown") next = (pos + 1) % n;
    else if (e.key === "ArrowUp") next = (pos - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter") {
      e.preventDefault();
      run(pos);
      return;
    } else return;
    e.preventDefault();
    setFocusPos(next);
  };

  const activeId =
    filtered.length > 0
      ? "hs-palette-opt-" + filtered[pos].cmd.id
      : undefined;

  return (
    <div
      className="hs-palette"
      role="dialog"
      aria-label={t.regionLabel}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="search"
        className="hs-palette__input"
        role="combobox"
        aria-expanded="true"
        aria-controls="hs-palette-list"
        aria-activedescendant={activeId}
        aria-label={t.inputLabel}
        placeholder={t.placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFocusPos(0);
        }}
      />
      {filtered.length === 0 ? (
        <p className="hs-palette__empty">{t.empty}</p>
      ) : (
        <ul
          id="hs-palette-list"
          ref={listRef}
          className="hs-palette__list"
          role="listbox"
          aria-label={t.listLabel}
        >
          {filtered.map(({ cmd, section }, p) => {
            const enabled = isEnabled(cmd.id);
            return (
              <li
                key={cmd.id}
                id={"hs-palette-opt-" + cmd.id}
                role="option"
                data-pos={p}
                aria-selected={p === pos}
                aria-disabled={enabled ? undefined : true}
                className={
                  "hs-palette__item" +
                  (p === pos ? " hs-palette__item--focus" : "") +
                  (enabled ? "" : " hs-palette__item--disabled")
                }
                onClick={() => run(p)}
                onMouseMove={() => {
                  if (p !== pos) setFocusPos(p);
                }}
              >
                <span className="hs-palette__section">
                  {sectionLabel(section)}
                </span>
                <span className="hs-palette__name">{cmd.title}</span>
                {cmd.shortcuts?.[0] && (
                  <kbd className="hs-palette__kbd">{cmd.shortcuts[0]}</kbd>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
