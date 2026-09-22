import { Toolbar, ToolbarButton, Tooltip } from "@fluentui/react-components";
import {
  FolderOpen24Regular,
  Play24Regular,
  CheckmarkCircle24Regular,
  ArrowExportUp24Regular,
  Settings24Regular,
  MoreHorizontal24Regular,
  PanelRight24Regular,
  Wrench24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";
import { HsMenu, type HsMenuItem } from "./primitives/Menu";
import { PitchSegmented, type PitchView } from "./PitchSegmented";
import {
  hasWorkspaceRegions,
  type ScreenState,
} from "../workspace/screen";

/** Tooltip text: Japanese title plus its canonical shortcut, e.g.
 *  「書き出し（Ctrl+E）」 — shortcut hinting is spec'd on §9 controls. */
function withShortcut(title: string, shortcut?: string): string {
  return shortcut ? `${title}（${shortcut}）` : title;
}

/**
 * Command bar (GUI_UX_SPEC §16, DESIGN_SYSTEM §10).
 * Left: project actions. Center: pitch selector. Right: 要確認/書き出し/設定/overflow.
 * Never scrolls; at <1600px secondary labels collapse to icon+tooltip
 * (§21), at <1200px 設定 moves into the overflow menu. The menu always
 * carries the properties show/close toggle so the panel stays reachable.
 *
 * EMPTY state (§3) hides every score/audio command — only 開く, 設定 and
 * the overflow menu render, so the empty surface stays free of score tools.
 *
 * Every action routes through the command surface (§23): enabled state,
 * Japanese label and shortcut all come from the registry, so the button,
 * the menu item and the keyboard binding can never disagree.
 */
export function CommandBar({
  commands,
  pitch,
  screen,
  reviewCount,
  compact,
  propertiesOpen,
  onToggleProperties,
}: {
  commands: CommandSurface;
  pitch: PitchView;
  screen: ScreenState;
  reviewCount: number;
  /** <1200px breakpoint — 設定 lives in the overflow menu instead. */
  compact: boolean;
  propertiesOpen: boolean;
  onToggleProperties(): void;
}) {
  // 採譜 ↔ 採譜し直す — same command slot, label follows score presence
  // (the registry hides retranscribe until a score exists).
  const transcribeId = "score.transcribe";
  const retranscribeId = "score.retranscribe";
  const transcribe = commands.isVisible(retranscribeId)
    ? retranscribeId
    : transcribeId;

  const onPitch = (v: PitchView) =>
    commands.invoke(v === "concert" ? "view.concertPitch" : "view.hornF");

  // EMPTY and the import error states (§3/§20) keep the command bar to
  // shell actions only — no score/audio commands without a live context.
  const loaded = hasWorkspaceRegions(screen);
  const hasScore =
    screen === "scoreReady" || screen === "reviewing" || screen === "exporting";
  const transcribeTooltip = hasScore
    ? ja.commandBar.retranscribeTooltip
    : ja.commandBar.transcribeTooltip;
  const reviewLabel =
    reviewCount > 0
      ? ja.commandBar.reviewWithCount.replace("{count}", String(reviewCount))
      : ja.commandBar.review;

  const overflowItems: HsMenuItem[] = [
    ...(compact
      ? [
          {
            key: "settings",
            label: commands.title("app.settings"),
            icon: <Settings24Regular />,
          } satisfies HsMenuItem,
        ]
      : []),
    {
      key: "properties",
      label: propertiesOpen ? ja.properties.close : ja.properties.show,
      icon: <PanelRight24Regular />,
    },
    { key: "overflow-divider", divider: true },
    // §16: diagnostics lives in the overflow, never on the command bar.
    {
      key: "diagnostics",
      label: commands.title("app.diagnostics"),
      icon: <Wrench24Regular />,
    },
  ];

  return (
    <Toolbar
      className="hs-commandbar"
      aria-label={ja.commandBar.regionLabel}
      data-hs-focus-zone="commandbar"
      tabIndex={-1}
    >
      <Tooltip content={ja.commandBar.openTooltip} relationship="label">
        <ToolbarButton
          icon={<FolderOpen24Regular />}
          disabled={!commands.isEnabled("file.openAudio")}
          aria-keyshortcuts="Control+O"
          onClick={() => commands.invoke("file.openAudio")}
        >
          <span className="hs-commandbar__label">{ja.commandBar.openLabel}</span>
        </ToolbarButton>
      </Tooltip>
      {loaded ? (
        <Tooltip content={transcribeTooltip} relationship="label">
          <ToolbarButton
            icon={<Play24Regular />}
            disabled={!commands.isEnabled(transcribe)}
            appearance="primary"
            onClick={() => commands.invoke(transcribe)}
          >
            <span className="hs-commandbar__label">
              {commands.title(transcribe)}
            </span>
          </ToolbarButton>
        </Tooltip>
      ) : null}

      {loaded ? <span className="hs-commandbar__spacer" /> : null}
      {loaded ? <PitchSegmented value={pitch} onChange={onPitch} /> : null}
      <span className="hs-commandbar__spacer" />

      {loaded ? (
        <Tooltip content={reviewLabel} relationship="label">
          <ToolbarButton
            icon={<CheckmarkCircle24Regular />}
            disabled={!commands.isEnabled("review.open")}
            onClick={() => commands.invoke("review.open")}
          >
            <span className="hs-commandbar__label">{reviewLabel}</span>
          </ToolbarButton>
        </Tooltip>
      ) : null}
      {loaded ? (
        <Tooltip
          content={withShortcut(
            ja.commandBar.exportTooltip,
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
            <span className="hs-commandbar__label">
              {commands.title("export.open")}
            </span>
          </ToolbarButton>
        </Tooltip>
      ) : null}
      {!compact && commands.isEnabled("app.settings") ? (
        <Tooltip
          content={commands.title("app.settings")}
          relationship="label"
        >
          <ToolbarButton
            icon={<Settings24Regular />}
            onClick={() => commands.invoke("app.settings")}
          />
        </Tooltip>
      ) : null}
      <HsMenu
        trigger={
          <ToolbarButton
            icon={<MoreHorizontal24Regular />}
            aria-label={ja.commandBar.overflow}
          />
        }
        items={overflowItems}
        ariaLabel={ja.commandBar.overflow}
        onSelect={(key) => {
          if (key === "settings") commands.invoke("app.settings");
          else if (key === "properties") onToggleProperties();
          else if (key === "diagnostics") commands.invoke("app.diagnostics");
        }}
      />
    </Toolbar>
  );
}
