/**
 * Native file drop (UI-020; GUI_UX_SPEC §3 "ドロップ → 音源読込").
 *
 * With `dragDropEnabled: true` (tauri.conf.json) the webview does NOT get
 * HTML5 drop events — Tauri intercepts them and emits `onDragDropEvent`
 * payloads carrying real filesystem paths. In plain-browser dev the HTML5
 * drop on the score region supplies `File` objects instead, and this
 * listener resolves to a no-op (same degrade pattern as tauri/bridge.ts).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface NativeDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  /** Dropped file paths (present on enter/over/drop). */
  paths: string[];
}

/**
 * Subscribe to the window drag-drop stream. `cb` receives every payload so
 * the caller can drive both the drop affordance (enter/over/leave) and the
 * import itself (drop). Resolves to an unsubscribe (identity no-op outside
 * the Tauri webview).
 */
export async function listenNativeDrop(
  cb: (payload: NativeDropPayload) => void,
): Promise<() => void> {
  try {
    const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
      const p = event.payload;
      cb({ type: p.type, paths: "paths" in p ? p.paths : [] });
    });
    return unlisten;
  } catch {
    return () => undefined;
  }
}
