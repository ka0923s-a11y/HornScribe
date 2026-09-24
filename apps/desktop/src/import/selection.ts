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
