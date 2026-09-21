import { ja } from "../strings/ja";

/**
 * Status / job area (GUI_UX_SPEC §2). Non-interactive status text; transient
 * command feedback is surfaced here during the spike.
 */
export function StatusBar({
  message,
  detail,
  engineStatus,
}: {
  message: string;
  detail?: string;
  /** Engine connection line (解析エンジン: …) — defaults to 未接続 so the
   *  empty shell stays honest before any sidecar session exists. */
  engineStatus?: string;
}) {
  return (
    <div
      className="hs-statusbar"
      role="status"
      aria-label={ja.status.regionLabel}
      data-hs-focus-zone="status"
      tabIndex={0}
    >
      <span className="hs-statusbar__message">{message}</span>
      <span className="hs-statusbar__spacer" />
      {detail ? <span>{detail}</span> : null}
      <span>{engineStatus ?? ja.status.engineNotConnected}</span>
    </div>
  );
}
