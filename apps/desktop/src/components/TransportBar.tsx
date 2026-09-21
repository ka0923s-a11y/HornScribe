import { Toolbar, ToolbarButton, Tooltip } from "@fluentui/react-components";
import {
  Previous24Regular,
  Play24Regular,
  Next24Regular,
  ArrowRepeatAll24Regular,
  SlideTextSparkle24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";

/**
 * Transport bar (GUI_UX_SPEC §9). Always reachable once audio is loaded;
 * rendered disabled in the spike's EMPTY state to exercise disabled styling
 * (color + cursor, not opacity alone — DESIGN_SYSTEM §17).
 */
export function TransportBar({ enabled }: { enabled: boolean }) {
  return (
    <Toolbar
      className="hs-transport"
      aria-label={ja.transport.regionLabel}
    >
      <Tooltip content={ja.transport.skipBack} relationship="label">
        <ToolbarButton
          icon={<Previous24Regular />}
          aria-label={ja.transport.skipBack}
          disabled={!enabled}
        />
      </Tooltip>
      <Tooltip content={`${ja.transport.playPause}（Space）`} relationship="label">
        <ToolbarButton
          icon={<Play24Regular />}
          aria-label={ja.transport.play}
          disabled={!enabled}
          appearance="primary"
        />
      </Tooltip>
      <Tooltip content={ja.transport.skipForward} relationship="label">
        <ToolbarButton
          icon={<Next24Regular />}
          aria-label={ja.transport.skipForward}
          disabled={!enabled}
        />
      </Tooltip>
      <span className="hs-transport__time" aria-label={ja.transport.position}>
        {ja.time.zero} / {ja.time.zeroTotal}
      </span>

      <span className="hs-transport__spacer" />

      <Tooltip content={`${ja.transport.rate} 1.0×`} relationship="label">
        <ToolbarButton disabled={!enabled}>1.0×</ToolbarButton>
      </Tooltip>
      <Tooltip content={`${ja.transport.loop}（Ctrl+L）`} relationship="label">
        <ToolbarButton
          icon={<ArrowRepeatAll24Regular />}
          aria-label={ja.transport.loop}
          disabled={!enabled}
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
