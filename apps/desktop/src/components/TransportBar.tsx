import { Toolbar, ToolbarButton, Tooltip } from "@fluentui/react-components";
import {
  Previous24Regular,
  Rewind24Regular,
  Play24Regular,
  Stop24Regular,
  FastForward24Regular,
  Next24Regular,
  ArrowRepeatAll24Regular,
  SlideTextSparkle24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import type { CommandSurface } from "../commands/registry";

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
 */
export function TransportBar({ commands }: { commands: CommandSurface }) {
  // All transport commands share the hasAudio gate (see definitions).
  const enabled = commands.isEnabled("transport.playPause");
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
          icon={<Play24Regular />}
          aria-label={commands.title("transport.playPause")}
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
        {ja.time.zero} / {ja.time.zeroTotal}
      </span>

      <span className="hs-transport__spacer" />

      <Tooltip content={`${ja.transport.rate} 1.0×`} relationship="label">
        <ToolbarButton disabled={!enabled}>1.0×</ToolbarButton>
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
      <Tooltip content={ja.transport.follow} relationship="label">
        <ToolbarButton
          icon={<SlideTextSparkle24Regular />}
          aria-label={ja.transport.follow}
          disabled={!enabled}
        />
      </Tooltip>
    </Toolbar>
  );
}
