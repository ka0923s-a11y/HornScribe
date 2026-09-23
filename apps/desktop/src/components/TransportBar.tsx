import { Toolbar, ToolbarButton, Tooltip } from "@fluentui/react-components";
import {
  Previous24Regular,
  Rewind24Regular,
  Play24Regular,
  Pause24Regular,
  Stop24Regular,
  FastForward24Regular,
  Next24Regular,
  ArrowRepeatAll24Regular,
  SlideTextSparkle24Regular,
  MusicNote2PlayRegular,
  Speaker224Regular,
  SpeakerMute24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";
import { formatTimecode } from "../import/format";

function withShortcut(title: string, shortcut?: string): string {
  return shortcut ? `${title}（${shortcut}）` : title;
}

/**
 * Transport bar (GUI_UX_SPEC §9). Mounted only once audio exists; every
 * control stays disabled while a command's snapshot predicate is false.
 *
 * All actions dispatch through the command surface (§23) — the Space key,
 * this button and a future menu item are the same command, so enabled
 * state and Japanese labels can never disagree across surfaces.
 *
 * `live` mirrors the transport adapter's low-frequency snapshot (UI-020):
 * play/pause icon, the MM:SS.t position/duration readout and the rate
 * button reflect the real audio clock. When no media transport is live but
 * a score clock runs (dev score-only path, UI-030), `timeLabel` supplies
 * the same readout; otherwise the static placeholder shows.
 */
export function TransportBar({
  commands,
  live,
  onCycleRate,
  timeLabel,
  followEnabled,
  followSuspended,
  onToggleFollow,
  auditionEnabled,
}: {
  commands: CommandSurface;
  live?: {
    isPlaying: boolean;
    positionSec: number;
    durationSec: number;
    rate: number;
    /** 元音源ミュート状態(#72)。 */
    muted?: boolean;
  };
  /** 再生速度 button — cycles SUPPORTED_RATES when the transport is live. */
  onCycleRate?(): void;
  /** [UI-030] "mm:ss.t / mm:ss.t" readout from the score clock when the
   *  media transport has no loaded source (score-only playback). */
  timeLabel?: string;
  /** [UI-030] 再生位置追従 armed state (§11); undefined = no score clock. */
  followEnabled?: boolean;
  /** [UI-030] Manual scroll suspended follow — button resumes it. */
  followSuspended?: boolean;
  onToggleFollow?(): void;
  /** FEAT-001 (#60): 楽譜の自動演奏がオンか(score clock がある時のみ)。 */
  auditionEnabled?: boolean;
}) {
  // All transport commands share the hasAudio gate (see definitions).
  const enabled = commands.isEnabled("transport.playPause");
  const position = live
    ? formatTimecode(live.positionSec)
    : (timeLabel?.split(" / ")[0] ?? ja.time.zero);
  const duration = live
    ? formatTimecode(live.durationSec)
    : (timeLabel?.split(" / ")[1] ?? ja.time.zeroTotal);
  const rateLabel = live ? `${live.rate}×` : "1.0×";
  return (
    <Toolbar
      className="hs-transport"
      aria-label={ja.transport.regionLabel}
      data-hs-focus-zone="transport"
      tabIndex={-1}
    >
      <Tooltip
        content={withShortcut(
          commands.title("transport.seekStart"),
          commands.shortcutLabel("transport.seekStart"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<Previous24Regular />}
          aria-label={commands.title("transport.seekStart")}
          aria-keyshortcuts="Home"
          disabled={!commands.isEnabled("transport.seekStart")}
          onClick={() => commands.invoke("transport.seekStart")}
        />
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.jumpBack"),
          commands.shortcutLabel("transport.jumpBack"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<Rewind24Regular />}
          aria-label={commands.title("transport.jumpBack")}
          aria-keyshortcuts="J"
          disabled={!commands.isEnabled("transport.jumpBack")}
          onClick={() => commands.invoke("transport.jumpBack")}
        />
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.playPause"),
          commands.shortcutLabel("transport.playPause"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={live?.isPlaying ? <Pause24Regular /> : <Play24Regular />}
          aria-label={
            live?.isPlaying ? ja.transport.pause : ja.transport.play
          }
          aria-keyshortcuts="Space K"
          disabled={!commands.isEnabled("transport.playPause")}
          appearance="primary"
          onClick={() => commands.invoke("transport.playPause")}
        />
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.stop"),
          commands.shortcutLabel("transport.stop"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<Stop24Regular />}
          aria-label={commands.title("transport.stop")}
          aria-keyshortcuts="Shift+Space"
          disabled={!commands.isEnabled("transport.stop")}
          onClick={() => commands.invoke("transport.stop")}
        />
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.jumpForward"),
          commands.shortcutLabel("transport.jumpForward"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<FastForward24Regular />}
          aria-label={commands.title("transport.jumpForward")}
          aria-keyshortcuts="L"
          disabled={!commands.isEnabled("transport.jumpForward")}
          onClick={() => commands.invoke("transport.jumpForward")}
        />
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.seekEnd"),
          commands.shortcutLabel("transport.seekEnd"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<Next24Regular />}
          aria-label={commands.title("transport.seekEnd")}
          aria-keyshortcuts="End"
          disabled={!commands.isEnabled("transport.seekEnd")}
          onClick={() => commands.invoke("transport.seekEnd")}
        />
      </Tooltip>
      <span className="hs-transport__time" aria-label={ja.transport.position}>
        {position} / {duration}
      </span>

      <span className="hs-transport__spacer" />

      <Tooltip
        content={`${ja.transport.rate} ${rateLabel}`}
        relationship="label"
      >
        <ToolbarButton
          aria-label={`${ja.transport.rate} ${rateLabel}`}
          disabled={!enabled}
          onClick={onCycleRate}
        >
          {rateLabel}
        </ToolbarButton>
      </Tooltip>
      <Tooltip
        content={withShortcut(
          commands.title("transport.toggleLoop"),
          commands.shortcutLabel("transport.toggleLoop"),
        )}
        relationship="label"
      >
        <ToolbarButton
          icon={<ArrowRepeatAll24Regular />}
          aria-label={commands.title("transport.toggleLoop")}
          aria-keyshortcuts="Control+L"
          disabled={!commands.isEnabled("transport.toggleLoop")}
          onClick={() => commands.invoke("transport.toggleLoop")}
        />
      </Tooltip>
      <Tooltip
        content={
          followSuspended ? ja.scoreView.resumeFollow : ja.transport.follow
        }
        relationship="label"
      >
        <ToolbarButton
          icon={<SlideTextSparkle24Regular />}
          aria-label={
            followSuspended ? ja.scoreView.resumeFollow : ja.transport.follow
          }
          aria-pressed={followEnabled === true && !followSuspended}
          disabled={!enabled}
          onClick={onToggleFollow}
        />
      </Tooltip>
      {/* FEAT-001: 楽譜の自動演奏。スコアがある時だけ有効。 */}
      <Tooltip
        content={
          auditionEnabled ? ja.transport.auditionOn : ja.transport.auditionOff
        }
        relationship="label"
      >
        <ToolbarButton
          icon={<MusicNote2PlayRegular />}
          aria-label={
            auditionEnabled
              ? ja.transport.auditionOn
              : ja.transport.auditionOff
          }
          aria-pressed={auditionEnabled === true}
          disabled={!commands.isEnabled("transport.toggleAudition")}
          onClick={() => commands.invoke("transport.toggleAudition")}
        />
      </Tooltip>
      {/* #72: 元音源のミュート — 楽譜の演奏だけを聴く用途。 */}
      <Tooltip
        content={
          live?.muted ? ja.transport.unmuteSource : ja.transport.muteSource
        }
        relationship="label"
      >
        <ToolbarButton
          icon={live?.muted ? <SpeakerMute24Regular /> : <Speaker224Regular />}
          aria-label={
            live?.muted ? ja.transport.unmuteSource : ja.transport.muteSource
          }
          aria-pressed={live?.muted === true}
          disabled={!commands.isEnabled("transport.toggleSourceMute")}
          onClick={() => commands.invoke("transport.toggleSourceMute")}
        />
      </Tooltip>
    </Toolbar>
  );
}
