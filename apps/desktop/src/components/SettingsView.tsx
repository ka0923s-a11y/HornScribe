import { Radio, RadioGroup, Label } from "@fluentui/react-components";
import { ArrowLeft24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { ThemeMode } from "../theme/fluentTheme";
import { HsButton } from "./primitives/Button";
import { HsPanel } from "./primitives/Panel";

/**
 * 設定 — auxiliary screen, not a work mode (GUI_UX_SPEC §18).
 * Only 外観→テーマ is functional in this spike; remaining sections render as
 * placeholders so the page structure and Japanese density are testable.
 */
export function SettingsView({
  themeMode,
  onThemeMode,
  onBack,
}: {
  themeMode: ThemeMode;
  onThemeMode(m: ThemeMode): void;
  onBack(): void;
}) {
  return (
    <div
      className="hs-settings"
      role="region"
      aria-label={ja.settings.regionLabel}
      data-hs-focus-zone="settings"
      tabIndex={-1}
    >
      <HsButton
        variant="subtle"
        icon={<ArrowLeft24Regular />}
        onClick={onBack}
      >
        {ja.settings.back}
      </HsButton>
      <h1 className="hs-settings__title">{ja.settings.title}</h1>

      <HsPanel
        title={ja.settings.appearanceSection}
        titleLevel={2}
        className="hs-settings__section"
      >
        <Label id="hs-theme-label">{ja.settings.themeLabel}</Label>
        <RadioGroup
          aria-labelledby="hs-theme-label"
          value={themeMode}
          onChange={(_, data) => onThemeMode(data.value as ThemeMode)}
        >
          <Radio value="system" label={ja.settings.themeSystem} />
          <Radio value="light" label={ja.settings.themeLight} />
          <Radio value="dark" label={ja.settings.themeDark} />
        </RadioGroup>
      </HsPanel>

      {(
        [
          ja.settings.playbackSection,
          ja.settings.transcriptionSection,
          ja.settings.exportSection,
          ja.settings.toolsSection,
          ja.settings.advancedSection,
        ] as const
      ).map((title) => (
        <HsPanel
          key={title}
          title={title}
          titleLevel={2}
          className="hs-settings__section"
        >
          <p className="hs-settings__note">{ja.settings.placeholder}</p>
        </HsPanel>
      ))}
    </div>
  );
}
