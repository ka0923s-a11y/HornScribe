/**
 * #318: キーボードショートカット一覧ヘルプ (F1)。
 *
 * コマンドレジストリの `section`/`title`/`shortcuts` メタデータから自動
 * 生成するため、定義と表示が乖離しない。`listVisible(snapshot)` で
 * 現在の画面で実際に使えるコマンドだけをセクション別に並べる。
 */
import { useMemo } from "react";
import { ja } from "../strings/ja";
import type { Command } from "../commands/types";
import { HsButton } from "./primitives/Button";
import { HsDialog } from "./primitives/Dialog";

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

export interface ShortcutsHelpProps {
  /** Registry command list — already filtered to the live snapshot. */
  commands: readonly Command[];
  /** Whether the help dialog is open (App owns the state). */
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function ShortcutsHelp({
  commands,
  open,
  onOpenChange,
}: ShortcutsHelpProps) {
  const groups = useMemo(() => {
    const bySection = new Map<string, Command[]>();
    for (const cmd of commands) {
      if (!cmd.shortcuts || cmd.shortcuts.length === 0) continue;
      const list = bySection.get(cmd.section) ?? [];
      list.push(cmd);
      bySection.set(cmd.section, list);
    }
    return SECTION_ORDER.filter((s) => bySection.has(s)).map((s) => ({
      section: s,
      items: bySection.get(s)!,
    }));
  }, [commands]);

  return (
    <HsDialog
      open={open}
      title={ja.shortcutsHelp.title}
      onOpenChange={onOpenChange}
      actions={
        <HsButton variant="primary" onClick={() => onOpenChange(false)}>
          {ja.common.close}
        </HsButton>
      }
    >
      {groups.length === 0 ? (
        <p className="hs-shortcuts__empty">{ja.shortcutsHelp.empty}</p>
      ) : (
        <div className="hs-shortcuts">
          {groups.map(({ section, items }) => (
            <section key={section} className="hs-shortcuts__group">
              <h3 className="hs-shortcuts__section">
                {sectionLabel(section)}
              </h3>
              <ul className="hs-shortcuts__list">
                {items.map((cmd) => (
                  <li key={cmd.id} className="hs-shortcuts__row">
                    <span className="hs-shortcuts__name">{cmd.title}</span>
                    <span className="hs-shortcuts__keys">
                      {cmd.shortcuts!.map((k) => (
                        <kbd key={k} className="hs-shortcuts__kbd">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </HsDialog>
  );
}
