import { ja } from "../strings/ja";

/**
 * Status / job area (GUI_UX_SPEC §2). Non-interactive status text; transient
 * command feedback is surfaced here during the spike.
 */
export function StatusBar({
  message,
  detail,
  engineStatus,
  unsaved,
  autosaveFailed,
}: {
  message: string;
  detail?: string;
  /** Engine connection line (解析エンジン: …) — defaults to 未接続 so the
   *  empty shell stays honest before any sidecar session exists. */
  engineStatus?: string;
  /** #300: 未保存の変更インジケータ — TitleBar の * だけでは
   *  気づかれにくいので、常時表示のステータスバーにも出す。 */
  unsaved?: boolean;
  /** #408: persistent warning while the autosave safety net is broken.
   *  Non-modal (editing continues) but it stays up until a recovery
   *  write lands or the work is saved another way. */
  autosaveFailed?: boolean;
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
      {unsaved ? (
        <span className="hs-statusbar__unsaved">
          {ja.project.unsavedBadge}
        </span>
      ) : null}
      {autosaveFailed ? (
        <span
          className="hs-statusbar__autosave-failed"
          title={ja.project.autosaveFailedHint}
        >
          {ja.project.autosaveFailedBadge}
        </span>
      ) : null}
      <span className="hs-statusbar__spacer" />
      {detail ? <span>{detail}</span> : null}
      <span>{engineStatus ?? ja.status.engineNotConnected}</span>
    </div>
  );
}
