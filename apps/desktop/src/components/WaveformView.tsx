import { useMemo } from "react";
import { ja } from "../strings/ja";
import { resizeKeyDelta, startPointerResize } from "../workspace/layout";
import type { LoadedAudio } from "../import/types";
import type { CaptureState } from "../capture/controller";
import { formatTimecode } from "../import/format";

/** Peak-column path for the strip: one <path> keeps redraw cost flat —
 *  vertical bars centred on the midline (the UI-004 wavesurfer adapter
 *  lands later; peaks geometry is already the real decoded audio). */
function peaksPath(peaks: readonly number[]): string {
  let d = "";
  for (let i = 0; i < peaks.length; i++) {
    const p = Math.min(1, Math.max(0, peaks[i]));
    d += `M${i + 0.5} ${50 - p * 48}L${i + 0.5} ${50 + p * 48}`;
  }
  return d;
}

/**
 * Waveform / timeline region (GUI_UX_SPEC §2, §8).
 * Height is user-resizable: 64px minimum up to ≈35% of the work area, and
 * always smaller than the score. The bottom-edge separator supports pointer
 * drag, ArrowUp/ArrowDown (±8px) and double-click reset — deterministic
 * clamps live in workspace/layout.ts.
 *
 * UI-020: renders decoded peaks + playhead once audio loads (§4), the
 * 波形を読み込んでいます line while OPENING_AUDIO, and click-to-seek
 * (§8) against the transport clock. Drag-select/zoom land with the real
 * waveform feature; the region stays honest about what exists.
 */
export function WaveformView({
  height,
  min,
  max,
  onResize,
  onReset,
  audio,
  loading = false,
  positionSec,
  onSeek,
  captureState,
}: {
  height: number;
  min: number;
  max: number;
  onResize(px: number): void;
  onReset(): void;
  /** Decoded audio (UI-020) — peaks render, null keeps the placeholder. */
  audio?: Pick<
    LoadedAudio,
    "fileName" | "durationSeconds" | "peaks"
  > | null;
  /** OPENING_AUDIO — honest loading line instead of fake peaks. */
  loading?: boolean;
  /** Audio-clock position for the playhead (seconds). */
  positionSec?: number;
  /** §8 click → seek: receives the target time in seconds. */
  onSeek?(seconds: number): void;
  /** FEAT-001 (#60): recording state — while a capture runs the strip
   *  shows the live recording status instead of a file's peaks. */
  captureState?: CaptureState | null;
}) {
  const path = useMemo(
    () => (audio ? peaksPath(audio.peaks) : ""),
    [audio],
  );
  const duration = audio?.durationSeconds ?? 0;
  const ratio =
    positionSec != null && duration > 0
      ? Math.min(1, Math.max(0, positionSec / duration))
      : null;
  return (
    <div
      className="hs-waveform"
      role="region"
      aria-label={ja.waveform.regionLabel}
      data-hs-focus-zone="waveform"
      tabIndex={0}
      style={{ height }}
      onClick={
        onSeek && duration > 0
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const r = (e.clientX - rect.left) / Math.max(1, rect.width);
              onSeek(Math.min(1, Math.max(0, r)) * duration);
            }
          : undefined
      }
    >
      {loading ? (
        <span className="hs-waveform__placeholder">
          {ja.import.waveform.loading}
        </span>
      ) : captureState?.phase === "recording" ? (
        <span
          className="hs-waveform__recording"
          role="status"
          aria-live="polite"
        >
          {captureState.source === "loopback"
            ? ja.transport.recordingLoopbackLabel
            : ja.transport.recordingLabel}
          {" — "}
          {formatTimecode(captureState.elapsedSeconds)}
          {captureState.deviceName ? ` · ${captureState.deviceName}` : ""}
          {/* #71: 入力レベルの簡易メーター(0-1 のピーク)。 */}
          <span
            className="hs-waveform__level"
            aria-hidden="true"
          >
            <span
              className="hs-waveform__level-fill"
              style={{
                width: `${Math.round(
                  Math.min(1, Math.max(0, captureState.level ?? 0)) * 100,
                )}%`,
              }}
            />
          </span>
        </span>
      ) : audio ? (
        <>
          <svg
            className="hs-waveform__peaks"
            viewBox={`0 0 ${audio.peaks.length} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={path} />
          </svg>
          {ratio !== null ? (
            <div
              className="hs-waveform__playhead"
              style={{ left: `${ratio * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
          <span className="hs-waveform__name" aria-hidden="true">
            {audio.fileName}
          </span>
        </>
      ) : (
        <span className="hs-waveform__placeholder">
          {ja.waveform.placeholder}
        </span>
      )}
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
        onClick={(e) => e.stopPropagation()}
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
