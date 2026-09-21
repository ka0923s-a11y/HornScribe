import { ja } from "../strings/ja";

/**
 * Status / job area (GUI_UX_SPEC §2). Non-interactive status text; transient
 * command feedback is surfaced here during the spike.
 */
export function StatusBar({
  message,
  detail,
}: {
  message: string;
  detail?: string;
}) {
  return (
    <div
      className="hs-statusbar"
      role="status"
      aria-label={ja.status.regionLabel}
    >
      <span className="hs-statusbar__message">{message}</span>
      <span className="hs-statusbar__spacer" />
      {detail ? <span>{detail}</span> : null}
      <span>{ja.status.engineNotConnected}</span>
    </div>
  );
}
