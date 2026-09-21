import {
  Button,
  Radio,
  RadioGroup,
  Label,
} from "@fluentui/react-components";
import { ArrowLeft24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { ThemeMode } from "../theme/fluentTheme";

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
    <div className="hs-settings" role="region" aria-label={ja.settings.regionLabel}>
      <Button
        appearance="subtle"
        icon={<ArrowLeft24Regular />}
        onClick={onBack}
      >
        {ja.settings.back}
      </Button>
      <h1 className="hs-settings__title">{ja.settings.title}</h1>

      <section className="hs-settings__section">
        <h2 className="hs-settings__section-title">
          {ja.settings.appearanceSection}
        </h2>
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
      </section>

      {(
        [
          ja.settings.playbackSection,
          ja.settings.transcriptionSection,
          ja.settings.exportSection,
          ja.settings.toolsSection,
          ja.settings.advancedSection,
        ] as const
      ).map((title) => (
        <section key={title} className="hs-settings__section">
          <h2 className="hs-settings__section-title">{title}</h2>
          <p className="hs-settings__note">{ja.settings.placeholder}</p>
        </section>
      ))}
    </div>
  );
}
