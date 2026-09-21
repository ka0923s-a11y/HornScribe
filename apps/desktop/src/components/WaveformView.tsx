import { ja } from "../strings/ja";
import { resizeKeyDelta, startPointerResize } from "../workspace/layout";

/**
 * Waveform / timeline region (GUI_UX_SPEC §2, §8).
 * Height is user-resizable: 64px minimum up to ≈35% of the work area, and
 * always smaller than the score. The bottom-edge separator supports pointer
 * drag, ArrowUp/ArrowDown (±8px) and double-click reset — deterministic
 * clamps live in workspace/layout.ts.
 */
export function WaveformView({
  height,
  min,
  max,
  onResize,
  onReset,
}: {
  height: number;
  min: number;
  max: number;
  onResize(px: number): void;
  onReset(): void;
}) {
  return (
    <div
      className="hs-waveform"
      role="region"
      aria-label={ja.waveform.regionLabel}
      data-hs-focus-zone="waveform"
      tabIndex={0}
      style={{ height }}
    >
      <span className="hs-waveform__placeholder">
        {ja.waveform.placeholder}
      </span>
      <div
        className="hs-waveform__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={ja.waveform.resizeHandle}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(e) => {
          const startH = height;
          const startY = e.clientY;
          startPointerResize(e, onResize, (_x, y) => startH + (y - startY));
        }}
        onKeyDown={(e) => {
          const next = resizeKeyDelta(e, height);
          if (next != null) {
            e.preventDefault();
            onResize(next);
          }
        }}
        onDoubleClick={onReset}
      />
    </div>
  );
}
