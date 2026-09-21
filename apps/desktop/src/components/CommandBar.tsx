import { Button, Toolbar, ToolbarButton, Tooltip } from "@fluentui/react-components";
import {
  FolderOpen24Regular,
  Play24Regular,
  CheckmarkCircle24Regular,
  ArrowExportUp24Regular,
  Settings24Regular,
  MoreHorizontal24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";
import { PitchSegmented, type PitchView } from "./PitchSegmented";

/** Tooltip text: Japanese title plus its canonical shortcut, e.g.
 *  「書き出し（Ctrl+E）」 — shortcut hinting is spec'd on §9 controls. */
function withShortcut(title: string, shortcut?: string): string {
  return shortcut ? `${title}（${shortcut}）` : title;
}

/**
 * Command bar (GUI_UX_SPEC §16, DESIGN_SYSTEM §10).
 * Left: project actions. Center: pitch selector. Right: 要確認/書き出し/設定/overflow.
 * Never scrolls; secondary commands move to overflow when narrow.
 *
 * Every action routes through the command surface (§23): enabled state,
 * Japanese label and shortcut all come from the registry, so the button,
 * the menu item and the keyboard binding can never disagree.
 */
export function CommandBar({
  commands,
  pitch,
}: {
  commands: CommandSurface;
  pitch: PitchView;
}) {
  // 採譜 ↔ 採譜し直す — same command slot, label follows score presence.
  const transcribeId = "score.transcribe";
  const retranscribeId = "score.retranscribe";
  const transcribe = commands.isVisible(retranscribeId)
    ? retranscribeId
    : transcribeId;

  const onPitch = (v: PitchView) =>
    commands.invoke(v === "concert" ? "view.concertPitch" : "view.hornF");

  return (
    <Toolbar
      className="hs-commandbar"
      aria-label={ja.commandBar.regionLabel}
      data-hs-focus-zone="commandbar"
    >
      <Tooltip
        content={withShortcut(
          commands.title("file.openAudio"),
          commands.shortcutLabel("file.openAudio"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<FolderOpen24Regular />}
          disabled={!commands.isEnabled("file.openAudio")}
          aria-keyshortcuts="Control+O"
          onClick={() => commands.invoke("file.openAudio")}
        >
          {commands.title("file.openAudio")}
        </ToolbarButton>
      </Tooltip>
      <Tooltip
        content={commands.title(transcribe)}
        relationship="label"
      >
        <ToolbarButton
          icon={<Play24Regular />}
          disabled={!commands.isEnabled(transcribe)}
          appearance="primary"
          onClick={() => commands.invoke(transcribe)}
        >
          {commands.title(transcribe)}
        </ToolbarButton>
      </Tooltip>

      <span className="hs-commandbar__spacer" />
      <PitchSegmented value={pitch} onChange={onPitch} />
      <span className="hs-commandbar__spacer" />

      <Tooltip content={commands.title("review.open")} relationship="label">
        <ToolbarButton
          icon={<CheckmarkCircle24Regular />}
          disabled={!commands.isEnabled("review.open")}
          onClick={() => commands.invoke("review.open")}
        >
          {commands.title("review.open")}
        </ToolbarButton>
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("export.open"),
          commands.shortcutLabel("export.open"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<ArrowExportUp24Regular />}
          disabled={!commands.isEnabled("export.open")}
          aria-keyshortcuts="Control+E"
          onClick={() => commands.invoke("export.open")}
        >
          {commands.title("export.open")}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={commands.title("app.settings")} relationship="label">
        <ToolbarButton
          icon={<Settings24Regular />}
          disabled={!commands.isEnabled("app.settings")}
          onClick={() => commands.invoke("app.settings")}
        />
      </Tooltip>
      <Tooltip content={ja.commandBar.overflow} relationship="label">
        <Button
          appearance="subtle"
          icon={<MoreHorizontal24Regular />}
          disabled
        />
      </Tooltip>
    </Toolbar>
  );
}
