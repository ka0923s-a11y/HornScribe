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
  Open24Regular,
  Mic24Regular,
  Speaker2Regular,
  Stop24Regular,
  Pause24Regular,
  Dismiss24Regular,
  ArrowUp24Regular,
  ArrowDown24Regular,
  ArrowLeft24Regular,
  ArrowRight24Regular,
  Link24Regular,
  MusicNote224Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";
import { HsMenu, type HsMenuItem } from "./primitives/Menu";
import { PitchSegmented, type PitchView } from "./PitchSegmented";
import {
  hasWorkspaceRegions,
  type ScreenState,
} from "../workspace/screen";
import type { CaptureState } from "../capture/controller";
import type {
  CaptureDeviceList,
  CaptureSource,
} from "../capture/types";
import { formatTimecode } from "../import/format";

/** 録音経過の短い表示(0:00 形式)。 */
function formatElapsed(seconds: number): string {
  return formatTimecode(seconds);
}

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
  captureState,
  captureDevices,
  captureSelectedDevice,
  onSelectCaptureDevice,
  onCaptureMenuOpen,
}: {
  commands: CommandSurface;
  pitch: PitchView;
  screen: ScreenState;
  reviewCount: number;
  /** <1200px breakpoint — 設定 lives in the overflow menu instead. */
  compact: boolean;
  propertiesOpen: boolean;
  onToggleProperties(): void;
  /** FEAT-001 (#60): live capture state for the recording affordance. */
  captureState?: CaptureState | null;
  /** #73: 取り込みデバイス一覧(メニュー開時に最新化される)。 */
  captureDevices?: CaptureDeviceList | null;
  /** 選択中のデバイス ID(null = 既定)。 */
  captureSelectedDevice?(source: CaptureSource): string | null;
  onSelectCaptureDevice?(source: CaptureSource, id: string | null): void;
  /** メニューが開いた時にデバイス一覧を取り直す。 */
  onCaptureMenuOpen?(): void;
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
    // §13 高度編集: hand the live score to MuseScore (score only — the
    // item hides on import screens like the 書き出し button does).
    ...(hasScore
      ? [
          {
            key: "musescore",
            label: commands.title("export.openInMuseScore"),
            icon: <Open24Regular />,
            disabled: !commands.isEnabled("export.openInMuseScore"),
          } satisfies HsMenuItem,
        ]
      : []),
    // #115 (spec 13): per-note rhythm edits — menu-only discoverability;
    // the keyboard chords do the real work. Disabled without a note
    // selection (the command registry owns the gate).
    ...(hasScore
      ? [
          { key: "rhythm-divider", divider: true } satisfies HsMenuItem,
          {
            key: "note-longer",
            label: commands.title("score.noteLonger"),
            icon: <ArrowUp24Regular />,
            disabled: !commands.isEnabled("score.noteLonger"),
          } satisfies HsMenuItem,
          {
            key: "note-shorter",
            label: commands.title("score.noteShorter"),
            icon: <ArrowDown24Regular />,
            disabled: !commands.isEnabled("score.noteShorter"),
          } satisfies HsMenuItem,
          {
            key: "note-shift-left",
            label: commands.title("score.noteShiftLeft"),
            icon: <ArrowLeft24Regular />,
            disabled: !commands.isEnabled("score.noteShiftLeft"),
          } satisfies HsMenuItem,
          {
            key: "note-shift-right",
            label: commands.title("score.noteShiftRight"),
            icon: <ArrowRight24Regular />,
            disabled: !commands.isEnabled("score.noteShiftRight"),
          } satisfies HsMenuItem,
          {
            key: "note-tie",
            label: commands.title("score.toggleTie"),
            icon: <Link24Regular />,
            disabled: !commands.isEnabled("score.toggleTie"),
          } satisfies HsMenuItem,
          // #130 (spec 14): score-wide re-quantize — always enabled with
          // a score (no selection needed); opens the settings dialog.
          {
            key: "requantize",
            label: commands.title("score.requantize"),
            icon: <MusicNote224Regular />,
            disabled: !commands.isEnabled("score.requantize"),
          } satisfies HsMenuItem,
        ]
      : []),
    { key: "overflow-divider", divider: true },
    // §16: diagnostics lives in the overflow, never on the command bar.
    {
      key: "diagnostics",
      label: commands.title("app.diagnostics"),
      icon: <Wrench24Regular />,
    },
  ];

  // FEAT-001: capture menu lives next to 開く — sources of new audio.
  // #73: 各ソースの下にそのソースのデバイス選択を並べる。選択中は ✓。
  const deviceItems = (
    source: CaptureSource,
    devices: readonly { id: string; name: string; isDefault: boolean }[],
  ): HsMenuItem[] => {
    // デバイスが1台も無いソース(ブラウザ dev の loopback 等)は
    // セクション自体を出さない — 既定しか選べない行は誤解を招く。
    if (devices.length === 0) return [];
    const selected = captureSelectedDevice?.(source) ?? null;
    const sectionLabel =
      source === "loopback"
        ? ja.capture.loopbackDeviceLabel
        : ja.capture.microphoneDeviceLabel;
    const items: HsMenuItem[] = [
      { key: source + "-hdr", label: sectionLabel, disabled: true },
      {
        key: source + ":default",
        label:
          selected === null
            ? "\u2713 " + ja.capture.defaultDevice
            : ja.capture.defaultDevice,
      },
    ];
    for (const d of devices) {
      items.push({
        key: source + ":" + d.id,
        label: selected === d.id ? "\u2713 " + d.name : d.name,
      });
    }
    return items;
  };
  const captureMenuItems: HsMenuItem[] = [
    {
      key: "loopback",
      label: commands.title("media.captureSystemAudio"),
      icon: <Speaker2Regular />,
      disabled: !commands.isEnabled("media.captureSystemAudio"),
    },
    {
      key: "microphone",
      label: commands.title("media.captureMicrophone"),
      icon: <Mic24Regular />,
      disabled: !commands.isEnabled("media.captureMicrophone"),
    },
    // デバイスセクションは一覧が取れた時だけ出す(ブラウザ dev では
    // loopback は空、mic のみ)。両方空なら区切り線ごと出さない。
    ...(captureDevices &&
    (captureDevices.loopback.length > 0 ||
      captureDevices.microphone.length > 0)
      ? ([
          { key: "devices-divider", divider: true },
          ...deviceItems("loopback", captureDevices.loopback),
          ...deviceItems("microphone", captureDevices.microphone),
        ] satisfies HsMenuItem[])
      : []),
  ];
  const recording = captureState?.phase === "recording";
  const captureLabel =
    recording && captureState?.source === "loopback"
      ? ja.transport.recordingLoopbackLabel
      : recording
        ? ja.transport.recordingLabel
        : "取り込み";

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

      {/* FEAT-001: 録音ソース — EMPTY/READY どちらでも新しい音源を取り込める。
          録音中は「停止して取り込む」「やめる」の 2 操作に切り替わる。 */}
      {!recording ? (
        <HsMenu
          trigger={
            <ToolbarButton icon={<Mic24Regular />} aria-label={captureLabel}>
              <span className="hs-commandbar__label">{captureLabel}</span>
            </ToolbarButton>
          }
          items={captureMenuItems}
          ariaLabel={captureLabel}
          onOpenChange={(open) => {
            if (open) onCaptureMenuOpen?.();
          }}
          onSelect={(key) => {
            if (key === "loopback") commands.invoke("media.captureSystemAudio");
            else if (key === "microphone") commands.invoke("media.captureMicrophone");
            else if (key === "loopback:default")
              onSelectCaptureDevice?.("loopback", null);
            else if (key === "microphone:default")
              onSelectCaptureDevice?.("microphone", null);
            else if (key.startsWith("loopback:"))
              onSelectCaptureDevice?.("loopback", key.slice("loopback:".length));
            else if (key.startsWith("microphone:"))
              onSelectCaptureDevice?.(
                "microphone",
                key.slice("microphone:".length),
              );
          }}
        />
      ) : (
        <>
          <Tooltip content={commands.title("media.stopCapture")} relationship="label">
            <ToolbarButton
              icon={<Stop24Regular />}
              appearance="primary"
              aria-keyshortcuts="Ctrl+Enter"
              onClick={() => commands.invoke("media.stopCapture")}
            >
              <span className="hs-commandbar__label">
                {commands.title("media.stopCapture")}
                {captureState?.elapsedSeconds != null
                  ? ` ${formatElapsed(captureState.elapsedSeconds)}`
                  : ""}
                {captureState?.paused ? ` — ${ja.capture.pausedLabel}` : ""}
              </span>
            </ToolbarButton>
          </Tooltip>
          {/* #80: 一時停止/再開 — paused 中はアイコンと対象コマンドが
              切り替わる。停止・中止は paused 中もそのまま使える。 */}
          {captureState?.paused ? (
            <Tooltip content={commands.title("media.resumeCapture")} relationship="label">
              <ToolbarButton
                icon={<Play24Regular />}
                aria-label={commands.title("media.resumeCapture")}
                onClick={() => commands.invoke("media.resumeCapture")}
              />
            </Tooltip>
          ) : (
            <Tooltip content={commands.title("media.pauseCapture")} relationship="label">
              <ToolbarButton
                icon={<Pause24Regular />}
                aria-label={commands.title("media.pauseCapture")}
                onClick={() => commands.invoke("media.pauseCapture")}
              />
            </Tooltip>
          )}
          <Tooltip content={commands.title("media.cancelCapture")} relationship="label">
            <ToolbarButton
              icon={<Dismiss24Regular />}
              onClick={() => commands.invoke("media.cancelCapture")}
            />
          </Tooltip>
        </>
      )}

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
          else if (key === "musescore")
            commands.invoke("export.openInMuseScore");
          else if (key === "note-longer") commands.invoke("score.noteLonger");
          else if (key === "note-shorter") commands.invoke("score.noteShorter");
          else if (key === "note-shift-left")
            commands.invoke("score.noteShiftLeft");
          else if (key === "note-shift-right")
            commands.invoke("score.noteShiftRight");
          else if (key === "note-tie") commands.invoke("score.toggleTie");
          else if (key === "diagnostics") commands.invoke("app.diagnostics");
        }}
      />
    </Toolbar>
  );
}
