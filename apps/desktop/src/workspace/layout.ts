import { useCallback, useEffect, useState } from "react";

/**
 * Workspace layout state (docs/GUI_UX_SPEC.md §21 responsive, §26 session
 * restore).
 *
 * Breakpoints (window inner width, CSS px):
 *   >=1600  wide     properties docked 280–320px, full command labels
 *   1200–1599 medium  properties docked 240–280px, secondary labels icon化
 *   1100–1199 compact properties becomes an overlay drawer, less-frequent
 *                    commands move to overflow; score keeps priority
 *   <1100   not supported — the native window minimum (1100px) stops resize
 *           before this; the CSS min-width mirrors it as a deterministic
 *           floor so the layout can never compress below the spec.
 *
 * All resize math is clamp-based and deterministic: the stored value is the
 * user's *requested* size, the rendered size is always `clamp(requested,
 * breakpointRange)` — crossing a breakpoint re-clamps without losing the
 * request.
 */
export type LayoutBreakpoint = "wide" | "medium" | "compact";

export function breakpointForWidth(width: number): LayoutBreakpoint {
  if (width >= 1600) return "wide";
  if (width >= 1200) return "medium";
  return "compact";
}

/** Docked/overlay width limits per breakpoint (§21). */
export function propertiesRange(bp: LayoutBreakpoint): {
  min: number;
  max: number;
  fallback: number;
} {
  switch (bp) {
    case "wide":
      return { min: 280, max: 320, fallback: 296 };
    case "medium":
      return { min: 240, max: 280, fallback: 264 };
    case "compact":
      // Overlay drawer: §21 gives no explicit band; keep the same order of
      // magnitude so the drawer never dwarfs the score it floats over.
      return { min: 240, max: 320, fallback: 280 };
  }
}

export function clampPropertiesWidth(
  requested: number,
  bp: LayoutBreakpoint,
): number {
  const { min, max } = propertiesRange(bp);
  return Math.min(max, Math.max(min, Math.round(requested)));
}

/* Waveform vertical band (§8): standard 96–120, min 64, max ≈35% of the
   work area (waveform + score region height). The work area is the window
   minus fixed chrome rows (title 32 + command bar 44 + transport 52 +
   status 26 = 154). */
export const WAVEFORM_DEFAULT = 96;
export const WAVEFORM_MIN = 64;
export const WORKSPACE_CHROME_HEIGHT = 154;

export function waveformMaxHeight(windowHeight: number): number {
  return Math.max(
    WAVEFORM_MIN,
    Math.round((windowHeight - WORKSPACE_CHROME_HEIGHT) * 0.35),
  );
}

export function clampWaveformHeight(
  requested: number,
  windowHeight: number,
): number {
  return Math.min(
    waveformMaxHeight(windowHeight),
    Math.max(WAVEFORM_MIN, Math.round(requested)),
  );
}

/* ----------------------------- persistence ----------------------------- */

const STORAGE_KEY = "hornscribe.layout.v1";

interface PersistedLayout {
  propertiesOpen?: boolean;
  propertiesWidth?: number;
  waveformHeight?: number;
  /** §26 session restore: last score zoom (%) and view mode. */
  scoreZoomPct?: number;
  scoreViewMode?: "continuous" | "page";
  /** §26: per-source waveform zoom windows, keyed by clip identity. */
  waveformViews?: Record<string, { startSec: number; endSec: number }>;
}

function loadLayout(): PersistedLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedLayout;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveLayout(layout: PersistedLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* persistence is best-effort */
  }
}

/* §26: per-session score view state, restored on the next launch.
 * Read/write goes through the same layout record so panel sizes and
 * view state never clobber each other. */
export interface ScoreSessionView {
  readonly zoomPct: number | null;
  readonly viewMode: "continuous" | "page" | null;
}

export function readScoreSessionView(): ScoreSessionView {
  const stored = loadLayout();
  const zoomPct =
    typeof stored.scoreZoomPct === "number" &&
    Number.isFinite(stored.scoreZoomPct)
      ? stored.scoreZoomPct
      : null;
  const viewMode =
    stored.scoreViewMode === "continuous" || stored.scoreViewMode === "page"
      ? stored.scoreViewMode
      : null;
  return { zoomPct, viewMode };
}

export function writeScoreSessionView(patch: {
  zoomPct?: number;
  viewMode?: "continuous" | "page";
}): void {
  const next = { ...loadLayout() };
  if (patch.zoomPct !== undefined) next.scoreZoomPct = patch.zoomPct;
  if (patch.viewMode !== undefined) next.scoreViewMode = patch.viewMode;
  saveLayout(next);
}

/* §26 waveform zoom: the view window is per-source — reopening the same
 * clip restores where the user was looking, a different clip starts
 * full. Identity is fileName + duration (what the audio payload carries);
 * entries are capped LRU-ish so a busy library cannot grow the record. */
const MAX_WAVEFORM_VIEWS = 16;

function waveformViewKey(fileName: string, durationSec: number): string {
  return fileName + "|" + durationSec.toFixed(3);
}

export function readWaveformView(
  fileName: string,
  durationSec: number,
): { startSec: number; endSec: number } | null {
  const stored = loadLayout().waveformViews?.[
    waveformViewKey(fileName, durationSec)
  ];
  if (
    !stored ||
    !Number.isFinite(stored.startSec) ||
    !Number.isFinite(stored.endSec) ||
    stored.endSec <= stored.startSec ||
    stored.startSec < 0 ||
    stored.startSec >= durationSec
  ) {
    return null;
  }
  return {
    startSec: stored.startSec,
    endSec: Math.min(stored.endSec, durationSec),
  };
}

export function writeWaveformView(
  fileName: string,
  durationSec: number,
  view: { startSec: number; endSec: number } | null,
): void {
  const next = { ...loadLayout() };
  const views = { ...(next.waveformViews ?? {}) };
  const key = waveformViewKey(fileName, durationSec);
  if (view === null) {
    delete views[key];
  } else {
    // Delete-then-set moves an existing key to the end so the cap
    // evicts the least-recently-touched clip, not a hot one.
    delete views[key];
    views[key] = { startSec: view.startSec, endSec: view.endSec };
    // Evict the oldest entries past the cap (insertion order — the
    // just-written key is last, so the front is the stalest).
    const keys = Object.keys(views);
    if (keys.length > MAX_WAVEFORM_VIEWS) {
      for (const stale of keys.slice(0, keys.length - MAX_WAVEFORM_VIEWS)) {
        delete views[stale];
      }
    }
  }
  next.waveformViews = views;
  saveLayout(next);
}

/* ------------------------------- hooks -------------------------------- */

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

export interface WorkspaceLayout {
  breakpoint: LayoutBreakpoint;
  /** Whether the properties panel is rendered (§6: user-closable). */
  propertiesOpen: boolean;
  /** Effective (clamped) docked/overlay panel width in px. */
  propertiesWidth: number;
  /** Effective (clamped) waveform height in px. */
  waveformHeight: number;
  /** Panel/waveform bounds for the current breakpoint — these drive the
      separator aria-valuemin/max contract. */
  propertiesMin: number;
  propertiesMax: number;
  waveformMin: number;
  waveformMax: number;
  setPropertiesOpen(open: boolean): void;
  /** Request a new docked width; stored raw, rendered clamped. */
  requestPropertiesWidth(px: number): void;
  requestWaveformHeight(px: number): void;
  resetPropertiesWidth(): void;
  resetWaveformHeight(): void;
}

export function useWorkspaceLayout(): WorkspaceLayout {
  const [stored, setStored] = useState<PersistedLayout>(loadLayout);
  const viewport = useViewportSize();
  const breakpoint = breakpointForWidth(viewport.width);

  const update = useCallback((patch: PersistedLayout) => {
    setStored((prev) => {
      const next = { ...prev, ...patch };
      saveLayout(next);
      return next;
    });
  }, []);

  const range = propertiesRange(breakpoint);
  const propertiesWidth = clampPropertiesWidth(
    stored.propertiesWidth ?? range.fallback,
    breakpoint,
  );
  const waveformHeight = clampWaveformHeight(
    stored.waveformHeight ?? WAVEFORM_DEFAULT,
    viewport.height,
  );

  return {
    breakpoint,
    // §6: closed while nothing is selected; user can reopen via the
    // command-bar overflow menu. EMPTY never mounts the region at all.
    propertiesOpen: stored.propertiesOpen ?? false,
    propertiesWidth,
    waveformHeight,
    propertiesMin: range.min,
    propertiesMax: range.max,
    waveformMin: WAVEFORM_MIN,
    waveformMax: waveformMaxHeight(viewport.height),
    setPropertiesOpen: useCallback(
      (open: boolean) => update({ propertiesOpen: open }),
      [update],
    ),
    requestPropertiesWidth: useCallback(
      (px: number) => update({ propertiesWidth: px }),
      [update],
    ),
    requestWaveformHeight: useCallback(
      (px: number) => update({ waveformHeight: px }),
      [update],
    ),
    resetPropertiesWidth: useCallback(
      () => update({ propertiesWidth: propertiesRange(breakpoint).fallback }),
      [update, breakpoint],
    ),
    resetWaveformHeight: useCallback(
      () => update({ waveformHeight: WAVEFORM_DEFAULT }),
      [update],
    ),
  };
}

/**
 * Pointer drag-resize for the panel separators. `toValue` maps a pointer
 * position to the requested size; `apply` receives it on every move.
 * Keyboard resize is handled by the separators themselves via
 * `resizeKeyDelta` (±8px on the 4px grid).
 */
export function startPointerResize(
  e: React.PointerEvent,
  apply: (value: number) => void,
  toValue: (clientX: number, clientY: number) => number,
): void {
  e.preventDefault();
  const move = (ev: PointerEvent) => apply(toValue(ev.clientX, ev.clientY));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Arrow-key resize delta for separators (grows on ←/↑, shrinks on →/↓). */
export function resizeKeyDelta(
  e: React.KeyboardEvent,
  base: number,
): number | null {
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") return base - 8;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") return base + 8;
  return null;
}
