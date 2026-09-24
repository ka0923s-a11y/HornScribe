/**
 * Waveform range selection math (#88 partial transcription).
 *
 * The waveform strip maps its full width to [0, durationSeconds]. A
 * pointer drag shorter than DRAG_THRESHOLD_PX stays a click (seek); a
 * longer drag becomes a selection range. All functions are pure so the
 * mapping is unit-testable without a DOM.
 */

/** Pointer travel (px) below which a press+release stays a click. */
export const DRAG_THRESHOLD_PX = 6;

/** A committed selection, in audio-clock seconds. */
export interface SelectionRange {
  startSec: number;
  endSec: number;
}

/** Horizontal pointer position -> audio time, clamped to the clip. */
export function clientXToSeconds(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  durationSec: number,
): number {
  if (rectWidth <= 0 || durationSec <= 0) return 0;
  const ratio = (clientX - rectLeft) / rectWidth;
  return Math.min(1, Math.max(0, ratio)) * durationSec;
}

/** Order + clamp a drag pair into a valid selection. */
export function normalizeSelection(
  aSec: number,
  bSec: number,
  durationSec: number,
): SelectionRange {
  const lo = Math.min(aSec, bSec);
  const hi = Math.max(aSec, bSec);
  const clamp = (v: number) => Math.min(Math.max(v, 0), Math.max(0, durationSec));
  return { startSec: clamp(lo), endSec: clamp(hi) };
}

/**
 * Fractional [0,1] band edges for rendering, or null when the range is
 * empty/inverted (nothing to paint). Live drags use the same path.
 */
export function selectionBand(
  range: SelectionRange | null,
  durationSec: number,
): { left: number; width: number } | null {
  if (!range || durationSec <= 0) return null;
  const norm = normalizeSelection(range.startSec, range.endSec, durationSec);
  if (norm.endSec <= norm.startSec) return null;
  const left = norm.startSec / durationSec;
  const right = norm.endSec / durationSec;
  return { left, width: Math.max(0, right - left) };
}

/* ------------------------------ zoom view ------------------------------- */

/** GUI_UX_SPEC 8/15: the waveform's visible time window ([0, duration]). */
export interface ViewRange {
  startSec: number;
  endSec: number;
}

/** Whole-clip view - the default before any Ctrl+wheel zoom. */
export function fullView(durationSec: number): ViewRange {
  return { startSec: 0, endSec: Math.max(0, durationSec) };
}

/** Smallest zoomable window - keeps a reset reachable and stops
 *  degenerate zero-width views. */
export const MIN_VIEW_SECONDS = 0.5;

/** True when the view shows the whole clip (zoom reset state). */
export function isFullView(view: ViewRange, durationSec: number): boolean {
  return (
    view.startSec <= 0 && view.endSec >= Math.max(0, durationSec) - 1e-9
  );
}

/** Clamp a candidate window into [0, duration], preserving its span. */
export function clampView(view: ViewRange, durationSec: number): ViewRange {
  const dur = Math.max(0, durationSec);
  const span = Math.min(Math.max(view.endSec - view.startSec, 0), dur);
  if (span <= 0 || dur <= 0) return fullView(dur);
  let start = view.startSec;
  if (start < 0) start = 0;
  if (start + span > dur) start = dur - span;
  return { startSec: start, endSec: start + span };
}

/**
 * Ctrl+wheel zoom (spec 15): scale the window around `anchorSec` (the
 * cursor's audio time) by `factor` (<1 zooms in, >1 zooms out), clamped
 * to [MIN_VIEW_SECONDS, duration].
 */
export function zoomView(
  view: ViewRange,
  anchorSec: number,
  factor: number,
  durationSec: number,
): ViewRange {
  const dur = Math.max(0, durationSec);
  if (dur <= 0) return fullView(dur);
  const clamped = clampView(view, dur);
  const span = clamped.endSec - clamped.startSec;
  const next = Math.min(dur, Math.max(MIN_VIEW_SECONDS, span * factor));
  const anchor = Math.min(Math.max(anchorSec, 0), dur);
  const t = span > 0 ? (anchor - clamped.startSec) / span : 0.5;
  return clampView(
    { startSec: anchor - t * next, endSec: anchor - t * next + next },
    dur,
  );
}

/** Wheel horizontal navigation (spec 8): shift the window by `deltaSec`. */
export function panView(
  view: ViewRange,
  deltaSec: number,
  durationSec: number,
): ViewRange {
  return clampView(
    { startSec: view.startSec + deltaSec, endSec: view.endSec + deltaSec },
    durationSec,
  );
}

/** Pointer position -> audio time inside a zoomed window. */
export function clientXInView(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  view: ViewRange,
): number {
  if (rectWidth <= 0) return view.startSec;
  const ratio = Math.min(1, Math.max(0, (clientX - rectLeft) / rectWidth));
  return view.startSec + ratio * Math.max(0, view.endSec - view.startSec);
}

/**
 * Fractional [0,1] band edges inside the current view (clamped to the
 * window), or null when the range does not intersect it.
 */
export function selectionBandInView(
  range: SelectionRange | null,
  view: ViewRange,
): { left: number; width: number } | null {
  if (!range) return null;
  const lo = Math.min(range.startSec, range.endSec);
  const hi = Math.max(range.startSec, range.endSec);
  const span = view.endSec - view.startSec;
  if (span <= 0) return null;
  const left = Math.max(lo, view.startSec);
  const right = Math.min(hi, view.endSec);
  if (right <= left) return null;
  return { left: (left - view.startSec) / span, width: (right - left) / span };
}
