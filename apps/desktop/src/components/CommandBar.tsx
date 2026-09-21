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
import type { Command } from "../commands/registry";
import { PitchSegmented, type PitchView } from "./PitchSegmented";

function byId(commands: Command[], id: string): Command {
  const c = commands.find((c) => c.id === id);
  if (!c) throw new Error(`unknown command ${id}`);
  return c;
}

/**
 * Command bar (GUI_UX_SPEC §16, DESIGN_SYSTEM §10).
 * Left: project actions. Center: pitch selector. Right: 要確認/書き出し/設定/overflow.
 * Never scrolls; secondary commands move to overflow when narrow.
 */
export function CommandBar({
  commands,
  ctx,
  pitch,
  onPitch,
}: {
  commands: Command[];
  ctx: { openAudioRequested(): void; openSettings(): void };
  pitch: PitchView;
  onPitch: (v: PitchView) => void;
}) {
  const open = byId(commands, "file.openAudio");
  const transcribe = byId(commands, "score.transcribe");
  const review = byId(commands, "review.open");
  const exportCmd = byId(commands, "export.open");
  const settings = byId(commands, "app.settings");

  return (
    <Toolbar className="hs-commandbar" aria-label={ja.commandBar.regionLabel}>
      <Tooltip content={ja.commandBar.open} relationship="label">
        <ToolbarButton
          icon={<FolderOpen24Regular />}
          disabled={!open.isEnabled()}
          onClick={ctx.openAudioRequested}
        >
          {ja.commandBar.open}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={ja.commandBar.transcribe} relationship="label">
        <ToolbarButton
          icon={<Play24Regular />}
          disabled={!transcribe.isEnabled()}
          appearance="primary"
        >
          {ja.commandBar.transcribe}
        </ToolbarButton>
      </Tooltip>

      <span className="hs-commandbar__spacer" />
      <PitchSegmented value={pitch} onChange={onPitch} />
      <span className="hs-commandbar__spacer" />

      <Tooltip content={ja.commandBar.review} relationship="label">
        <ToolbarButton
          icon={<CheckmarkCircle24Regular />}
          disabled={!review.isEnabled()}
        >
          {ja.commandBar.review}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={ja.commandBar.export} relationship="label">
        <ToolbarButton
          icon={<ArrowExportUp24Regular />}
          disabled={!exportCmd.isEnabled()}
        >
          {ja.commandBar.export}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={ja.commandBar.settings} relationship="label">
        <ToolbarButton
          icon={<Settings24Regular />}
          disabled={!settings.isEnabled()}
          onClick={ctx.openSettings}
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
