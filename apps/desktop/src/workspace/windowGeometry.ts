import {
  applyWindowGeometry,
  getWindowGeometry,
  onWindowGeometryChanged,
} from "../tauri/bridge";

/**
 * Window geometry persistence (docs/GUI_UX_SPEC.md §26).
 *
 * Layout state (panel sizes, visibility) lives in localStorage via
 * layout.ts; the native window size/position needs the webview ↔ shell
 * boundary, so it goes through tauri/bridge. Everything degrades to a no-op
 * in a plain browser dev session (invoke throws → caught in bridge).
 */

const STORAGE_KEY = "hornscribe.window.v1";

interface StoredGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

function load(): StoredGeometry | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as StoredGeometry;
    if (
      typeof g.width === "number" &&
      typeof g.height === "number" &&
      typeof g.x === "number" &&
      typeof g.y === "number"
    ) {
      return g;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function save(g: StoredGeometry): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(g));
  } catch {
    /* best-effort */
  }
}

/**
 * Re-apply the persisted window geometry on startup and keep it updated
 * while the window lives. Size/position are stored in *logical* px so a
 * restored window lands at the same physical size under 150/200% scaling.
 * Returns an unsubscribe function.
 */
export async function initWindowGeometryPersistence(): Promise<() => void> {
  const stored = load();
  if (stored) {
    await applyWindowGeometry(stored);
  }

  let timer: number | undefined;
  const persistSoon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      // While maximized the reported rect is the monitor — skip persisting
      // it so the restored size stays the user's normal geometry.
      void getWindowGeometry().then((g) => {
        if (g) save(g);
      });
    }, 400);
  };

  return onWindowGeometryChanged(persistSoon);
}
