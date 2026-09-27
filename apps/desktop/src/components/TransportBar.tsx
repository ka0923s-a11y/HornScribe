import { useState } from "react";
import {
  ToggleButton,
  Toolbar,
  ToolbarButton,
  Tooltip,
} from "@fluentui/react-components";
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
  SpeakerSettings24Regular,
  Headphones24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";
import { formatTimecode } from "../import/format";
import { HsPopover } from "./primitives/Popover";
import { HsSlider } from "./primitives/Slider";

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
  loopArmed,
  mixer,
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
  /** #113: A-B loop armed (media loop or score loop) - pressed state. */
  loopArmed?: boolean;
  /** #398: 音量ミキサー — per-part fader/mute/solo rows + the source fader.
   *  Present when either side exists; undefined hides the button. */
  mixer?: {
    readonly parts: readonly {
      name: string;
      volume: number;
      muted: boolean;
      solo: boolean;
    }[];
    onPartChange(
      index: number,
      patch: { volume?: number; muted?: boolean; solo?: boolean },
    ): void;
    /** 元音源 fader — only while audio is loaded. */
    readonly source?: { volume: number; onVolume(v: number): void } | null;
  };
}) {
  // #366: play/stop/seek/loop now reach the score clock too — the
  // rate and follow controls stay audio-only, so they key off the
  // still-hasAudio toggleSourceMute gate instead of playPause.
  const audioOnly = commands.isEnabled("transport.toggleSourceMute");
  const [mixerOpen, setMixerOpen] = useState(false);
  const mixerAvailable =
    mixer !== undefined && (mixer.parts.length > 0 || mixer.source != null);
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
          disabled={!audioOnly}
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
          aria-pressed={loopArmed === true}
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
          disabled={!audioOnly}
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
      {/* #398: 音量ミキサー — パート別 + 元音源の fader。再生中の音声に
          即時反映されるので、原曲と楽譜のバランスを聴きながら調整できる。 */}
      {/* #398: 音量ミキサー — パート別 + 元音源の fader。再生中の音声に
          即時反映されるので、原曲と楽譜のバランスを聴きながら調整できる。 */}
      <HsPopover
        open={mixerOpen}
        onOpenChange={setMixerOpen}
        positioning="above"
        ariaLabel={ja.transport.mixer}
        trigger={
          <ToolbarButton
            icon={<SpeakerSettings24Regular />}
            aria-label={ja.transport.mixer}
            /* disabledFocusable (#379 pattern): a disabled attr here would
               still match the focus-zone [tabindex] selector (PopoverTrigger
               injects tabindex=0) and swallow the F6 landing focus. */
            disabledFocusable={!mixerAvailable}
          />
        }
      >
        <div className="hs-mixer" role="group" aria-label={ja.transport.mixer}>
          {mixer?.source ? (
            <div className="hs-mixer__row">
              <HsSlider
                className="hs-mixer__slider"
                label={ja.transport.mixerSource}
                value={Math.round(mixer.source.volume * 100)}
                min={0}
                max={100}
                unit="%"
                onChange={(v) => mixer.source?.onVolume(v / 100)}
              />
            </div>
          ) : null}
          {mixer?.parts.map((part, i) => (
            <div className="hs-mixer__row" key={i}>
              <HsSlider
                className="hs-mixer__slider"
                label={part.name}
                value={Math.round(part.volume * 100)}
                min={0}
                max={100}
                unit="%"
                disabled={part.muted}
                onChange={(v) => mixer.onPartChange(i, { volume: v / 100 })}
              />
              <Tooltip
                content={
                  part.solo ? ja.transport.partUnsolo : ja.transport.partSolo
                }
                relationship="label"
              >
                <ToggleButton
                  className="hs-mixer__toggle"
                  size="small"
                  icon={<Headphones24Regular />}
                  checked={part.solo}
                  aria-label={
                    part.name +
                    ": " +
                    (part.solo ? ja.transport.partUnsolo : ja.transport.partSolo)
                  }
                  onClick={() => mixer.onPartChange(i, { solo: !part.solo })}
                />
              </Tooltip>
              <Tooltip
                content={
                  part.muted ? ja.transport.partUnmute : ja.transport.partMute
                }
                relationship="label"
              >
                <ToggleButton
                  className="hs-mixer__toggle"
                  size="small"
                  icon={
                    part.muted ? (
                      <SpeakerMute24Regular />
                    ) : (
                      <Speaker224Regular />
                    )
                  }
                  checked={part.muted}
                  aria-label={
                    part.name +
                    ": " +
                    (part.muted ? ja.transport.partUnmute : ja.transport.partMute)
                  }
                  onClick={() => mixer.onPartChange(i, { muted: !part.muted })}
                />
              </Tooltip>
            </div>
          ))}
        </div>
      </HsPopover>
    </Toolbar>
  );
}
