import type { ReactNode } from "react";
import {
  Button,
  Toolbar,
  ToolbarButton,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowExportUp24Regular,
  ArrowRepeatAll24Regular,
  CheckmarkCircle24Regular,
  ChevronLeft24Regular,
  Dismiss24Regular,
  DocumentBulletList24Regular,
  FolderOpen24Regular,
  MoreHorizontal24Regular,
  Next24Regular,
  Pause24Regular,
  Play24Regular,
  Previous24Regular,
  Settings24Regular,
  SlideTextSparkle24Regular,
  Stop24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { PitchSegmented } from "../components/PitchSegmented";
import { TitleBar } from "../components/TitleBar";
import { StatusBar } from "../components/StatusBar";
import type { PitchView, MockNote } from "./mockData";
import {
  DURATION_SEC,
  LOOP_RANGE,
  formatTime,
  noteName,
  spellingLabel,
  writtenMidi,
} from "./mockData";
import type { MockPlayer } from "./useMockPlayer";

/**
 * Prototype chrome — mirrors the real shell components' layout (same
 * hs-* classes) while exposing the state the UI-009 scenarios need.
 * Production strings come from ja.*; prototype-only labels from
 * ja.prototype.*.
 */

/* --------------------------- command bar --------------------------- */

export interface ProtoShellState {
  hasAudio: boolean;
  hasScore: boolean;
  reviewCount: number;
  transcribing?: boolean;
}

export type ProtoCommand =
  | "open"
  | "transcribe"
  | "review"
  | "export"
  | "settings"
  | "overflow";

export function ProtoCommandBar({
  state,
  pitch,
  onPitch,
  onCommand,
  longLabels = false,
}: {
  state: ProtoShellState;
  pitch: PitchView;
  onPitch(v: PitchView): void;
  onCommand(id: ProtoCommand): void;
  /** P2 density: use the longest plausible command labels. */
  longLabels?: boolean;
}) {
  const openLabel = longLabels ? ja.commandBar.open : "開く";
  const transcribeLabel = state.hasScore ? "採譜し直す" : "採譜";
  const reviewLabel = state.reviewCount > 0 ? `要確認（${state.reviewCount}）` : "要確認";
  return (
    <Toolbar className="hs-commandbar" aria-label={ja.commandBar.regionLabel}>
      <Tooltip content={`${ja.commandBar.open}（Ctrl+O）`} relationship="label">
        <ToolbarButton icon={<FolderOpen24Regular />} onClick={() => onCommand("open")}>
          {openLabel}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="採譜を開始する" relationship="label">
        <ToolbarButton
          icon={<Play24Regular />}
          appearance="primary"
          disabled={!state.hasAudio || state.transcribing}
          onClick={() => onCommand("transcribe")}
        >
          {transcribeLabel}
        </ToolbarButton>
      </Tooltip>

      <span className="hs-commandbar__spacer" />
      <PitchSegmented value={pitch} onChange={onPitch} />
      <span className="hs-commandbar__spacer" />

      <Tooltip content={ja.commandBar.review} relationship="label">
        <ToolbarButton
          icon={<CheckmarkCircle24Regular />}
          disabled={!state.hasScore || state.reviewCount === 0}
          onClick={() => onCommand("review")}
        >
          {reviewLabel}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="MusicXML・PDF・MIDIを書き出す" relationship="label">
        <ToolbarButton
          icon={<ArrowExportUp24Regular />}
          disabled={!state.hasScore}
          onClick={() => onCommand("export")}
        >
          {ja.commandBar.export}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={ja.commandBar.settings} relationship="label">
        <ToolbarButton
          icon={<Settings24Regular />}
          aria-label={ja.commandBar.settings}
          onClick={() => onCommand("settings")}
        />
      </Tooltip>
      <Tooltip content={ja.commandBar.overflow} relationship="label">
        <Button appearance="subtle" icon={<MoreHorizontal24Regular />} disabled />
      </Tooltip>
    </Toolbar>
  );
}

/* ----------------------------- waveform ----------------------------- */

export function ProtoWaveform({
  positionSec,
  loop,
  loopRange,
  loaded,
  onSeek,
}: {
  positionSec: number;
  loop: boolean;
  loopRange: { startSec: number; endSec: number } | null;
  loaded: boolean;
  onSeek?(sec: number): void;
}) {
  const bars: number[] = [];
  if (loaded) {
    // deterministic pseudo-waveform
    for (let i = 0; i < 120; i++) {
      const v = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.13));
      bars.push(0.15 + v * 0.85);
    }
  }
  const width = 720;
  const height = 72;
  const playX = (positionSec / DURATION_SEC) * width;
  return (
    <div
      className="hs-waveform hs-proto-waveform"
      role="region"
      aria-label={ja.waveform.regionLabel}
      tabIndex={0}
    >
      {loaded ? (
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onClick={(e) => {
            if (!onSeek) return;
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek(((e.clientX - rect.left) / rect.width) * DURATION_SEC);
          }}
        >
          {loop && loopRange && (
            <rect
              x={(loopRange.startSec / DURATION_SEC) * width}
              y={0}
              width={((loopRange.endSec - loopRange.startSec) / DURATION_SEC) * width}
              height={height}
              fill="var(--hs-waveform-selection)"
              aria-hidden="true"
            />
          )}
          {bars.map((h, i) => {
            const x = (i / bars.length) * width;
            const bh = h * (height - 10);
            return (
              <rect
                key={i}
                x={x + 1.5}
                y={(height - bh) / 2}
                width={width / bars.length - 3}
                height={bh}
                rx={1}
                fill={x <= playX ? "var(--hs-waveform-played)" : "var(--hs-waveform)"}
              />
            );
          })}
          <line
            x1={playX}
            x2={playX}
            y1={0}
            y2={height}
            stroke="var(--hs-playhead)"
            strokeWidth={2}
          />
        </svg>
      ) : (
        ja.waveform.placeholder
      )}
    </div>
  );
}

/* ----------------------------- transport ----------------------------- */

export function ProtoTransport({
  player,
  enabled,
}: {
  player: MockPlayer;
  enabled: boolean;
}) {
  const t = ja.prototype.transport;
  const followActive = player.follow === "on";
  return (
    <Toolbar className="hs-transport" aria-label={ja.transport.regionLabel}>
      <Tooltip content={`${t.skipBack}（J）`} relationship="label">
        <ToolbarButton
          icon={<Previous24Regular />}
          aria-label={t.skipBack}
          disabled={!enabled}
          onClick={() => player.seekBy(-5)}
        />
      </Tooltip>
      <Tooltip content={`${t.playPause}（Space）`} relationship="label">
        <ToolbarButton
          icon={player.playing ? <Pause24Regular /> : <Play24Regular />}
          aria-label={player.playing ? t.pause : t.play}
          disabled={!enabled}
          appearance="primary"
          onClick={player.togglePlay}
        />
      </Tooltip>
      <Tooltip content={`${t.stop}（Shift+Space）`} relationship="label">
        <ToolbarButton
          icon={<Stop24Regular />}
          aria-label={t.stop}
          disabled={!enabled}
          onClick={player.stop}
        />
      </Tooltip>
      <Tooltip content={`${t.skipForward}（L）`} relationship="label">
        <ToolbarButton
          icon={<Next24Regular />}
          aria-label={t.skipForward}
          disabled={!enabled}
          onClick={() => player.seekBy(5)}
        />
      </Tooltip>
      <span className="hs-transport__time" aria-label={t.position}>
        {formatTime(player.positionSec)} / {formatTime(DURATION_SEC)}
      </span>

      <span className="hs-transport__spacer" />

      <Tooltip content={`${t.rate} ${player.rate.toFixed(2).replace(/\.?0+$/, "")}×`} relationship="label">
        <ToolbarButton disabled={!enabled} onClick={player.cycleRate}>
          {player.rate.toFixed(2).replace(/\.?0+$/, "")}×
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={`${t.loopToggle}（Ctrl+L）`} relationship="label">
        <ToolbarButton
          icon={<ArrowRepeatAll24Regular />}
          aria-label={t.loop}
          aria-pressed={player.loop}
          disabled={!enabled}
          onClick={player.toggleLoop}
          className={player.loop ? "hs-proto-toggle--on" : undefined}
        />
      </Tooltip>
      <Tooltip content={t.followFull} relationship="label">
        <ToolbarButton
          icon={<SlideTextSparkle24Regular />}
          aria-label={t.followFull}
          aria-pressed={followActive}
          disabled={!enabled}
          onClick={() => player.setFollowOn(!followActive)}
          className={followActive ? "hs-proto-toggle--on" : undefined}
        >
          {t.follow}
        </ToolbarButton>
      </Tooltip>
    </Toolbar>
  );
}

/* ---------------------------- properties ---------------------------- */

export type NoteEditAction =
  | "pitchUp"
  | "pitchDown"
  | "enharmonic"
  | "delete"
  | "restore"
  | "playSource";

export function ProtoProperties({
  note,
  pitch,
  open,
  onClose,
  onReopen,
  onAction,
}: {
  note: MockNote | null;
  pitch: PitchView;
  open: boolean;
  onClose(): void;
  onReopen(): void;
  onAction?(a: NoteEditAction): void;
}) {
  const p = ja.prototype.properties;
  if (!open) {
    // Collapsed state: slim strip keeps the panel recoverable and proves
    // task completion does not depend on the panel being open (§21).
    return (
      <aside className="hs-proto-props-collapsed" aria-label={p.title}>
        <button type="button" className="hs-proto-props-reopen" onClick={onReopen}>
          <ChevronLeft24Regular aria-hidden="true" />
          <span>{p.reopen}</span>
        </button>
      </aside>
    );
  }
  const displayMidi = note ? writtenMidi(note.midiConcert, pitch) : null;
  return (
    <aside className="hs-properties" aria-label={ja.properties.regionLabel}>
      <div className="hs-proto-props__header">
        <h2 className="hs-properties__title">{p.title}</h2>
        <Tooltip content={p.close} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<Dismiss24Regular />}
            aria-label={p.close}
            onClick={onClose}
          />
        </Tooltip>
      </div>
      {note && displayMidi != null ? (
        <>
          <h3 className="hs-proto-props__section">{p.noteSection}</h3>
          <dl className="hs-proto-props__fields">
            <div>
              <dt>{p.fields.pitch}</dt>
              <dd>
                {noteName(displayMidi)}
                {pitch !== "concert" && (
                  <span className="hs-proto-props__dim">（{p.writtenNoteSuffix}）</span>
                )}
              </dd>
            </div>
            <div>
              <dt>{p.fields.spelling}</dt>
              <dd>{spellingLabel(displayMidi)}</dd>
            </div>
            <div>
              <dt>{p.fields.measure}</dt>
              <dd>第{note.measure}小節</dd>
            </div>
            <div>
              <dt>{p.fields.onset}</dt>
              <dd>{note.beat}拍目</dd>
            </div>
            <div>
              <dt>{p.fields.duration}</dt>
              <dd>{note.durationLabel}</dd>
            </div>
            <div>
              <dt>{p.fields.confidence}</dt>
              <dd>{note.confidence}%</dd>
            </div>
            <div>
              <dt>{p.fields.sourcePosition}</dt>
              <dd>{formatTime(note.onsetSec)}</dd>
            </div>
          </dl>
          {note.deleted && <p className="hs-proto-props__dim">{p.deleted}</p>}
          <div className="hs-proto-props__actions">
            <Button size="small" onClick={() => onAction?.("pitchUp")}>
              {p.actions.pitchUp}
            </Button>
            <Button size="small" onClick={() => onAction?.("pitchDown")}>
              {p.actions.pitchDown}
            </Button>
            <Button size="small" onClick={() => onAction?.("enharmonic")}>
              {p.actions.enharmonic}
            </Button>
            {note.deleted ? (
              <Button size="small" onClick={() => onAction?.("restore")}>
                {p.actions.restore}
              </Button>
            ) : (
              <Button size="small" onClick={() => onAction?.("delete")}>
                {p.actions.delete}
              </Button>
            )}
            <Button size="small" onClick={() => onAction?.("playSource")}>
              {p.actions.playSource}
            </Button>
          </div>
        </>
      ) : (
        <p className="hs-properties__body">{p.empty}</p>
      )}
    </aside>
  );
}

/* --------------------------- review banner --------------------------- */

export function ReviewBanner({
  count,
  onOpen,
}: {
  count: number;
  onOpen(): void;
}) {
  return (
    <div className="hs-proto-reviewbanner" role="note">
      <DocumentBulletList24Regular aria-hidden="true" />
      <span>{ja.prototype.reviewBanner.text(count)}</span>
      <Button appearance="primary" size="small" onClick={onOpen}>
        {ja.prototype.reviewBanner.cta}
      </Button>
    </div>
  );
}

/* ------------------------------ shell ------------------------------ */

export function ProtoShell({
  documentTitle,
  state,
  pitch,
  onPitch,
  onCommand,
  longLabels,
  player,
  transportEnabled,
  properties,
  banner,
  status,
  children,
}: {
  documentTitle?: string;
  state: ProtoShellState;
  pitch: PitchView;
  onPitch(v: PitchView): void;
  onCommand(id: ProtoCommand): void;
  longLabels?: boolean;
  player: MockPlayer;
  transportEnabled: boolean;
  properties?: ReactNode;
  banner?: ReactNode;
  status: string;
  children: ReactNode;
}) {
  return (
    <div className="hs-shell">
      <TitleBar documentTitle={documentTitle} />
      <ProtoCommandBar
        state={state}
        pitch={pitch}
        onPitch={onPitch}
        onCommand={onCommand}
        longLabels={longLabels}
      />
      <ProtoWaveform
        positionSec={player.positionSec}
        loop={player.loop}
        loopRange={LOOP_RANGE}
        loaded={state.hasAudio}
        onSeek={state.hasAudio ? (s) => player.seekTo(s) : undefined}
      />
      <div className="hs-main">
        <div className="hs-proto-scorecol">
          {banner}
          {children}
        </div>
        {properties}
      </div>
      <ProtoTransport player={player} enabled={transportEnabled} />
      <StatusBar message={status} />
    </div>
  );
}

