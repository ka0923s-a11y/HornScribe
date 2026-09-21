import { ja } from "../strings/ja";

/**
 * In-app title bar area (GUI_UX_SPEC §2). The native window title bar is
 * kept for the spike (decorations enabled, no window-control permissions
 * needed); this strip carries app + document identity inside the layout.
 */
export function TitleBar({ documentTitle }: { documentTitle?: string }) {
  return (
    <div className="hs-titlebar">
      <span className="hs-titlebar__app">{ja.app.name}</span>
      <span aria-hidden="true">—</span>
      <span className="hs-titlebar__doc">
        {documentTitle ?? ja.app.untitled}
      </span>
    </div>
  );
}
