import { useCallback, useEffect, useId, useState } from "react";
import {
  Checkbox,
  Input,
  Label,
  Radio,
  RadioGroup,
  mergeClasses,
} from "@fluentui/react-components";
import { ArrowLeft24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { ThemeMode } from "../theme/fluentTheme";
import { HsButton } from "./primitives/Button";
import { HsPanel } from "./primitives/Panel";
import { HsSelect } from "./primitives/Select";
import { HsNumericField } from "./primitives/NumericField";
import {
  StatusBadge,
  type StatusTone,
} from "./primitives/StatusBadge";
import type { ExportPort } from "../export/port";
import type { DiagnosticsPort } from "../diagnostics/port";
import type { DiagnosticsInfo, ToolInfo } from "../diagnostics/types";
import {
  SETTINGS_CATEGORIES,
  playbackRateOptions,
  type AppSettings,
  type SettingsCategory,
} from "../settings/store";
import {
  clearRecordings,
  formatBytes,
  getRecordingsInfo,
  openRecordingsDir,
  type RecordingsInfo,
} from "../capture/recordings";
import { HsDialog } from "./primitives/Dialog";

const CATEGORY_LABEL: Record<SettingsCategory, string> = {
  appearance: ja.settings.appearanceSection,
  playback: ja.settings.playbackSection,
  recordings: ja.settings.recordingsSection,
  transcription: ja.settings.transcriptionSection,
  score: ja.settings.scoreSection,
  export: ja.settings.exportSection,
  tools: ja.settings.toolsSection,
  advanced: ja.settings.advancedSection,
};

function toolBadge(info: ToolInfo | undefined): {
  tone: StatusTone;
  label: string;
} {
  const s = ja.dependencies;
  const status = info?.status ?? "checking";
  return status === "found"
    ? { tone: "success", label: s.statusFound }
    : status === "missing"
      ? { tone: "error", label: s.statusMissing }
      : status === "checking"
        ? { tone: "info", label: s.statusChecking }
        : { tone: "neutral", label: ja.diagnostics.unknown };
}

/**
 * Editable path field (tool locations, 既定の保存先). The draft commits on
 * blur/Enter so every keystroke does not re-probe tool status.
 */
function PathField({
  label,
  value,
  placeholder,
  onCommit,
  trailing,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit(value: string): void;
  trailing?: React.ReactNode;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="hs-settings__field">
      <Label id={id}>{label}</Label>
      <div className="hs-settings__path-row">
        <Input
          aria-labelledby={id}
          value={draft}
          placeholder={placeholder}
          onChange={(_, d) => setDraft(d.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") commit();
          }}
        />
        {trailing}
      </div>
    </div>
  );
}

/**
 * 設定 — auxiliary screen, not a work mode (GUI_UX_SPEC §18; issue UI-060).
 *
 * Left nav lists the categories (外観/再生/録音/採譜/楽譜/書き出し/ツール/
 * 詳細設定); only the selected panel renders, so advanced settings never
 * leak into the workspace. There is intentionally NO language setting —
 * the UI is Japanese-only by contract.
 *
 * Values persist to localStorage immediately (same precedent as the theme
 * switcher). Tool paths are user-editable; a non-empty path wins over
 * auto-detection in the diagnostics probe.
 */
export function SettingsView({
  themeMode,
  onThemeMode,
  onBack,
  settings,
  onSettingsChange,
  diagnosticsPort,
  exportPort,
  onOpenDiagnostics,
  onAnnounce,
  focusCategory,
}: {
  themeMode: ThemeMode;
  onThemeMode(m: ThemeMode): void;
  onBack(): void;
  settings: AppSettings;
  onSettingsChange(patch: Partial<AppSettings>): void;
  diagnosticsPort: DiagnosticsPort;
  exportPort: ExportPort;
  onOpenDiagnostics(): void;
  /** Status-bar announcements (role="status" is aria-live). */
  onAnnounce(message: string): void;
  /** Deep-link target (e.g. "export" from the MuseScore recovery action). */
  focusCategory?: SettingsCategory;
}) {
  const s = ja.settings;
  const [category, setCategory] = useState<SettingsCategory>(
    focusCategory ?? "appearance",
  );
  useEffect(() => {
    if (focusCategory) setCategory(focusCategory);
  }, [focusCategory]);

  // Tool status / paths for ツール + 詳細設定 — collected once, then again
  // whenever the user commits a different tool path (the override flips
  // the reported status to 検出済み).
  const [diag, setDiag] = useState<DiagnosticsInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void diagnosticsPort
      .collect({
        museScorePath: settings.museScorePath,
        ffmpegPath: settings.ffmpegPath,
      })
      .then((info) => {
        if (!cancelled) setDiag(info);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diagnosticsPort, settings.museScorePath, settings.ffmpegPath]);

  const pickExportDir = useCallback(async () => {
    try {
      const dir = await exportPort.chooseDestination(
        settings.defaultExportDir || undefined,
      );
      if (dir) onSettingsChange({ defaultExportDir: dir });
    } catch {
      /* picker unavailable (unsupported port) — the field stays editable */
    }
  }, [exportPort, settings.defaultExportDir, onSettingsChange]);

  const museBadge = toolBadge(diag?.tools.museScore);
  const ffmpegBadge = toolBadge(diag?.tools.ffmpeg);

  const openLogs = useCallback(async () => {
    const ok = await diagnosticsPort.openLogFolder();
    if (!ok) {
      // Honest feedback — the shell has no folder bridge yet.
      onAnnounce(ja.diagnostics.openLogsFailed);
    }
  }, [diagnosticsPort, onAnnounce]);

  // #78: 録音ファイル管理 — カテゴリを開いた時に情報を取り直す。
  const [recInfo, setRecInfo] = useState<RecordingsInfo | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const refreshRecordings = useCallback(() => {
    void getRecordingsInfo().then(setRecInfo);
  }, []);
  useEffect(() => {
    if (category === "recordings") refreshRecordings();
  }, [category, refreshRecordings]);

  const section = (() => {
    switch (category) {
      case "appearance":
        return (
          <>
            <Label id="hs-theme-label">{s.themeLabel}</Label>
            <RadioGroup
              aria-labelledby="hs-theme-label"
              value={themeMode}
              onChange={(_, data) => onThemeMode(data.value as ThemeMode)}
            >
              <Radio value="system" label={s.themeSystem} />
              <Radio value="light" label={s.themeLight} />
              <Radio value="dark" label={s.themeDark} />
            </RadioGroup>
          </>
        );

      case "playback":
        return (
          <>
            <HsSelect
              label={s.defaultRate}
              value={String(settings.playbackRate)}
              options={playbackRateOptions().map((r) => ({
                value: String(r),
                label: `${r}×`,
              }))}
              onChange={(v) =>
                onSettingsChange({ playbackRate: Number(v) })
              }
            />
            <HsNumericField
              label={s.skipSeconds}
              value={settings.skipSeconds}
              min={1}
              max={60}
              step={1}
              unit={s.secondsUnit}
              onChange={(v) =>
                v != null && onSettingsChange({ skipSeconds: v })
              }
            />
            <Checkbox
              checked={settings.followPlayback}
              onChange={(_, d) =>
                onSettingsChange({ followPlayback: d.checked === true })
              }
              label={s.followPlayback}
            />
          </>
        );

      case "recordings":
        return (
          <>
            <div className="hs-settings__field">
              <Label>{s.recordingsFolder}</Label>
              <div className="hs-settings__path-row">
                <p className="hs-settings__value">
                  {recInfo?.dir ?? ja.diagnostics.notConnected}
                </p>
                <HsButton
                  size="small"
                  disabled={!recInfo}
                  onClick={() => {
                    void openRecordingsDir().then((ok) => {
                      if (!ok) onAnnounce(s.recordingsUnavailable);
                    });
                  }}
                >
                  {s.recordingsOpen}
                </HsButton>
              </div>
            </div>
            <div className="hs-settings__field">
              <Label>{s.recordingsSection}</Label>
              <div className="hs-settings__path-row">
                <p className="hs-settings__value">
                  {recInfo
                    ? recInfo.fileCount > 0
                      ? `${s.recordingsCount(recInfo.fileCount)} — ${formatBytes(recInfo.totalBytes)}`
                      : s.recordingsEmpty
                    : s.recordingsUnavailable}
                </p>
                <HsButton
                  size="small"
                  disabled={!recInfo || recInfo.fileCount === 0}
                  onClick={() => setClearConfirmOpen(true)}
                >
                  {s.recordingsClear}
                </HsButton>
              </div>
            </div>
          </>
        );

      case "transcription":
        return (
          <>
            <HsSelect
              label={s.tempo}
              value={settings.tempoMode}
              options={[
                { value: "auto", label: s.tempoAuto },
                { value: "manual", label: s.tempoManual },
              ]}
              onChange={(v) =>
                onSettingsChange({
                  tempoMode: v === "manual" ? "manual" : "auto",
                })
              }
            />
            <HsNumericField
              label={s.bpm}
              value={settings.bpm}
              min={30}
              max={300}
              step={1}
              disabled={settings.tempoMode === "auto"}
              onChange={(v) => v != null && onSettingsChange({ bpm: v })}
            />
            <HsSelect
              label={s.meter}
              value={settings.meter}
              options={[
                { value: "auto", label: s.tempoAuto },
                { value: "4/4", label: "4/4" },
                { value: "3/4", label: "3/4" },
                { value: "6/8", label: "6/8" },
                { value: "2/4", label: "2/4" },
                { value: "5/4", label: "5/4" },
              ]}
              onChange={(v) =>
                onSettingsChange({
                  meter: v as AppSettings["meter"],
                })
              }
            />
            <HsSelect
              label={s.minDuration}
              value={settings.minDuration}
              options={[
                { value: "eighth", label: s.minDurationEighth },
                { value: "sixteenth", label: s.minDurationSixteenth },
                {
                  value: "thirtySecond",
                  label: s.minDurationThirtySecond,
                },
              ]}
              onChange={(v) =>
                onSettingsChange({
                  minDuration: v as AppSettings["minDuration"],
                })
              }
            />
            <Checkbox
              checked={settings.triplets}
              onChange={(_, d) =>
                onSettingsChange({ triplets: d.checked === true })
              }
              label={s.tripletsAllow}
            />
          </>
        );

      case "score":
        return (
          <HsSelect
            label={s.initialView}
            value={settings.scoreInitialView}
            options={[
              { value: "continuous", label: s.viewContinuous },
              { value: "page", label: s.viewPage },
            ]}
            onChange={(v) =>
              onSettingsChange({
                scoreInitialView: v === "page" ? "page" : "continuous",
              })
            }
          />
        );

      case "export":
        return (
          <>
            <PathField
              label={s.defaultFolder}
              value={settings.defaultExportDir}
              placeholder={s.folderPlaceholder}
              onCommit={(v) => onSettingsChange({ defaultExportDir: v })}
              trailing={
                <HsButton size="small" onClick={() => void pickExportDir()}>
                  {ja.common.browse}
                </HsButton>
              }
            />
            <PathField
              label={s.musescorePath}
              value={settings.museScorePath}
              placeholder={s.pathPlaceholder}
              onCommit={(v) => onSettingsChange({ museScorePath: v })}
              trailing={
                <StatusBadge tone={museBadge.tone} label={museBadge.label} />
              }
            />
          </>
        );

      case "tools":
        return (
          <>
            <div className="hs-settings__tool">
              <div className="hs-settings__tool-head">
                <span className="hs-settings__tool-name">FFmpeg</span>
                <StatusBadge
                  tone={ffmpegBadge.tone}
                  label={ffmpegBadge.label}
                />
              </div>
              <p className="hs-settings__note">
                {ja.dependencies.ffmpeg.purpose}
              </p>
              <PathField
                label={s.ffmpegPath}
                value={settings.ffmpegPath}
                placeholder={s.pathPlaceholder}
                onCommit={(v) => onSettingsChange({ ffmpegPath: v })}
              />
            </div>
            <div className="hs-settings__tool">
              <div className="hs-settings__tool-head">
                <span className="hs-settings__tool-name">MuseScore</span>
                <StatusBadge
                  tone={museBadge.tone}
                  label={museBadge.label}
                />
              </div>
              <p className="hs-settings__note">
                {ja.dependencies.musescore.purpose}
              </p>
              <PathField
                label={s.musescorePath}
                value={settings.museScorePath}
                placeholder={s.pathPlaceholder}
                onCommit={(v) => onSettingsChange({ museScorePath: v })}
              />
            </div>
            <div className="hs-settings__field">
              <Label>{s.modelInfo}</Label>
              <p className="hs-settings__value">
                {diag?.backend ?? ja.diagnostics.notConnected}
              </p>
            </div>
          </>
        );

      case "advanced":
        return (
          <>
            <HsSelect
              label={s.backendLabel}
              value={settings.backend}
              options={[
                { value: "auto", label: s.tempoAuto },
                { value: "basicPitch", label: "Basic Pitch" },
              ]}
              onChange={(v) =>
                onSettingsChange({
                  backend: v === "basicPitch" ? "basicPitch" : "auto",
                })
              }
            />
            <div className="hs-settings__field">
              <Label>{s.cache}</Label>
              <p className="hs-settings__value">
                {diag?.paths.cache ?? ja.diagnostics.notConnected}
              </p>
            </div>
            <div className="hs-settings__field">
              <Label>{s.logs}</Label>
              <div className="hs-settings__path-row">
                <p className="hs-settings__value">
                  {diag?.paths.logs ?? ja.diagnostics.notConnected}
                </p>
                <HsButton
                  size="small"
                  onClick={() => void openLogs()}
                >
                  {s.openLogs}
                </HsButton>
              </div>
            </div>
            <div className="hs-settings__field">
              <HsButton onClick={onOpenDiagnostics}>
                {s.openDiagnostics}
              </HsButton>
            </div>
          </>
        );
    }
  })();

  return (
    <div
      className="hs-settings"
      role="region"
      aria-label={s.regionLabel}
      data-hs-focus-zone="settings"
      tabIndex={-1}
    >
      <HsButton
        variant="subtle"
        icon={<ArrowLeft24Regular />}
        onClick={onBack}
      >
        {s.back}
      </HsButton>
      <h1 className="hs-settings__title">{s.title}</h1>

      <div className="hs-settings__layout">
        <nav className="hs-settings__nav" aria-label={s.navLabel}>
          {SETTINGS_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={mergeClasses(
                "hs-settings__nav-item",
                c === category && "hs-settings__nav-item--active",
              )}
              aria-current={c === category ? "true" : undefined}
              onClick={() => setCategory(c)}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </nav>

        <div className="hs-settings__content">
          <HsPanel
            key={category}
            title={CATEGORY_LABEL[category]}
            titleLevel={2}
            className="hs-settings__section"
          >
            <div className="hs-settings__fields">{section}</div>
          </HsPanel>
        </div>
      </div>

      {/* #78: 録音の全削除は破壊的操作 — alert 確認を挟む。 */}
      <HsDialog
        open={clearConfirmOpen}
        modalType="alert"
        title={s.recordingsClearConfirmTitle}
        onOpenChange={(open) => {
          if (!open) setClearConfirmOpen(false);
        }}
        actions={
          <>
            <HsButton
              variant="danger"
              onClick={() => {
                setClearConfirmOpen(false);
                void clearRecordings().then((freed) => {
                  if (freed !== null) {
                    onAnnounce(
                      `${s.recordingsCleared} (${formatBytes(freed)})`,
                    );
                  }
                  refreshRecordings();
                });
              }}
            >
              {s.recordingsClearConfirm}
            </HsButton>
            <HsButton
              variant="secondary"
              onClick={() => setClearConfirmOpen(false)}
            >
              {ja.capture.replaceCancel}
            </HsButton>
          </>
        }
      >
        <p style={{ margin: 0 }}>{s.recordingsClearConfirmBody}</p>
      </HsDialog>
    </div>
  );
}
