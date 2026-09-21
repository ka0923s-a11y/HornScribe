import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

/**
 * Shell↔Rust boundary.
 *
 * App-defined commands are invoked over Tauri's built-in IPC channel and are
 * NOT governed by capabilities/ACL (those apply to plugin/core commands).
 * No plugin permissions are required for `shell_info`.
 */
export interface ShellInfo {
  appName: string;
  version: string;
  rustTargetEnv: string;
}

/**
 * Returns null instead of throwing when the app runs outside the Tauri
 * webview (e.g. plain `vite dev` in a browser) so the shell still renders.
 */
export async function getShellInfo(): Promise<ShellInfo | null> {
  try {
    return await invoke<ShellInfo>("shell_info");
  } catch {
    return null;
  }
}

/**
 * Window geometry in *logical* px (GUI_UX_SPEC §26 session restore).
 * All helpers return null / no-op outside the Tauri webview or when the
 * capability ACL denies the call, so browser dev sessions stay safe.
 */
export interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Current window rect, or null while maximized (the maximized rect is the
 * monitor, not the user's geometry) and outside Tauri.
 */
export async function getWindowGeometry(): Promise<WindowGeometry | null> {
  try {
    const win = getCurrentWindow();
    if (await win.isMaximized()) return null;
    const scale = await win.scaleFactor();
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    return {
      width: size.width / scale,
      height: size.height / scale,
      x: pos.x / scale,
      y: pos.y / scale,
    };
  } catch {
    return null;
  }
}

export async function applyWindowGeometry(g: WindowGeometry): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(g.width, g.height));
    await win.setPosition(new LogicalPosition(g.x, g.y));
  } catch {
    /* no webview / ACL denied → ignore */
  }
}

/**
 * Subscribe to resize + move events; `cb` fires on either. Resolves to an
 * unsubscribe function (identity no-op outside Tauri).
 */
export async function onWindowGeometryChanged(
  cb: () => void,
): Promise<() => void> {
  try {
    const win = getCurrentWindow();
    const unResized = await win.onResized(cb);
    const unMoved = await win.onMoved(cb);
    return () => {
      unResized();
      unMoved();
    };
  } catch {
    return () => undefined;
  }
}
