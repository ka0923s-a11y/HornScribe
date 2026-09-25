import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "@fluentui/react-components";
import {
  ArrowRepeatAll24Regular,
  Play24Regular,
  ZoomIn24Regular,
  Dismiss24Regular,
  ZoomFit24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import {
  readWaveformView,
  resizeKeyDelta,
  startPointerResize,
  writeWaveformView,
} from "../workspace/layout";
import type { LoadedAudio } from "../import/types";
import type { CaptureState } from "../capture/controller";
import { formatTimecode } from "../import/format";
import {
  centerViewAt,
  clientXInView,
  clientXToSeconds,
  clampView,
  DRAG_THRESHOLD_PX,
  fullView,
  isFullView,
  normalizeSelection,
  panView,
  selectionBandInView,
  zoomView,
  type SelectionRange,
  type ViewRange,
} from "../import/selection";

/** #116 (spec 8): the minimap strip appears for long clips (>=5 min) or
 *  whenever the view is zoomed — short full-view clips don't need it. */
const MINIMAP_MIN_DURATION_SEC = 300;
/** Peaks columns in the minimap — fixed, so the strip stays cheap. */
const MINIMAP_COLUMNS = 160;

/** Downsample peaks to `columns` max-per-bucket values for the minimap. */
function minimapPeaks(
  peaks: readonly number[],
  columns: number,
): readonly number[] {
  if (peaks.length <= columns) return peaks;
  const out: number[] = new Array(columns).fill(0);
  const bucket = peaks.length / columns;
  for (let i = 0; i < columns; i++) {
    const lo = Math.floor(i * bucket);
    const hi = Math.min(
      peaks.length,
      Math.max(lo + 1, Math.ceil((i + 1) * bucket)),
    );
    let m = 0;
    for (let j = lo; j < hi; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
  }
  return out;
}

/** Peak-column path for the strip: one <path> keeps redraw cost flat -
 *  vertical bars centred on the midline. `peaks` is the slice currently
 *  inside the zoom window.
 */
function peaksPath(peaks: readonly number[]): string {
  let d = "";
  for (let i = 0; i < peaks.length; i++) {
    const p = Math.min(1, Math.max(0, peaks[i]));
    d += `M${i + 0.5} ${50 - p * 48}L${i + 0.5} ${50 + p * 48}`;
  }
  return d;
}

/** Slice the peaks array to the visible window so zooming redraws the
 *  same columns at a wider pitch (spec 8: Ctrl+wheel zoom). */
function peaksInView(
  peaks: readonly number[],
  view: ViewRange,
  durationSec: number,
): readonly number[] {
  if (durationSec <= 0 || peaks.length === 0) return peaks;
  const lo = Math.max(0, Math.floor((view.startSec / durationSec) * peaks.length));
  const hi = Math.min(
    peaks.length,
    Math.max(lo + 1, Math.ceil((view.endSec / durationSec) * peaks.length)),
  );
  return peaks.slice(lo, hi);
}

/** #376: a review-issue marker on the strip — index is the jump
 *  target the workspace's review cursor understands, label the
 *  accessible option name (reason title + source time). */
export interface WaveformMarker {
  readonly index: number;
  readonly startSec: number;
  readonly severity: "warning" | "caution" | "info";
  readonly label: string;
}

interface MarkerCluster {
  /** 0..1 position inside the current view window. */
  pos: number;
  severity: WaveformMarker["severity"];
  items: WaveformMarker[];
  label: string;
}

const SEVERITY_RANK: Record<WaveformMarker["severity"], number> = {
  warning: 0,
  caution: 1,
  info: 2,
};

/** Merge markers whose view positions sit closer than gapRatio —
 *  dense issue clusters stay a single reachable tick instead of a row
 *  of un-clickable slivers (acceptance #376). The cluster keeps the
 *  highest severity and jumps to its earliest issue. */
export function clusterMarkers(
  markers: readonly WaveformMarker[],
  view: ViewRange,
  gapRatio: number,
): MarkerCluster[] {
  const span = view.endSec - view.startSec;
  if (span <= 0) return [];
  const placed = markers
    .map((m) => ({ m, pos: (m.startSec - view.startSec) / span }))
    .filter((x) => x.pos >= 0 && x.pos <= 1)
    .sort((a, b) => a.pos - b.pos);
  const out: MarkerCluster[] = [];
  for (const { m, pos } of placed) {
    const last = out[out.length - 1];
    if (last && pos - last.pos < gapRatio) {
      last.items.push(m);
      if (SEVERITY_RANK[m.severity] < SEVERITY_RANK[last.severity]) {
        last.severity = m.severity;
      }
    } else {
      out.push({ pos, severity: m.severity, items: [m], label: m.label });
    }
  }
  for (const c of out) {
    if (c.items.length > 1) {
      c.label = ja.waveform.markerCluster(c.items.length, c.items[0].label);
    }
  }
  return out;
}

/**
 * Waveform / timeline region (GUI_UX_SPEC 2, 8).
 * Height is user-resizable: 64px minimum up to ~35% of the work area, and
 * always smaller than the score. The bottom-edge separator supports pointer
 * drag, ArrowUp/ArrowDown (±8px) and double-click reset - deterministic
 * clamps live in workspace/layout.ts.
 *
 * UI-020: renders decoded peaks + playhead once audio loads (spec 4), the
 * loading line while OPENING_AUDIO, and click-to-seek
 * (spec 8) against the transport clock.
 *
 * #88: when `onSelect` is provided (AUDIO_READY), a horizontal drag past
 * DRAG_THRESHOLD_PX commits a selection range instead of seeking - the
 * committed band plus live drag preview paint over the peaks. A plain
 * click still seeks so the user can audition the range edges.
 *
 * #113 (spec 8): the committed selection carries edge handles and a
 * context action bar (loop / play / zoom / clear); Esc clears it.
 * Ctrl+wheel zooms the visible window around the cursor and a plain wheel
 * pans it once zoomed; the zoom chip resets to the whole clip. The armed
 * A-B loop paints as a second band (`loop` prop).
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
  selection,
  onSelect,
  loop,
  onLoopSelection,
  onPlaySelection,
  onClearSelection,
  markers,
  onMarkerClick,
}: {
  height: number;
  min: number;
  max: number;
  onResize(px: number): void;
  onReset(): void;
  /** Decoded audio (UI-020) - peaks render, null keeps the placeholder. */
  audio?: Pick<
    LoadedAudio,
    "fileName" | "durationSeconds" | "peaks"
  > | null;
  /** OPENING_AUDIO - honest loading line instead of fake peaks. */
  loading?: boolean;
  /** Audio-clock position for the playhead (seconds). */
  positionSec?: number;
  /** spec 8 click -> seek: receives the target time in seconds. */
  onSeek?(seconds: number): void;
  /** FEAT-001 (#60): recording state - while a capture runs the strip
   *  shows the live recording status instead of a file's peaks. */
  captureState?: CaptureState | null;
  /** #88: committed selection (seconds) - renders the band when set. */
  selection?: SelectionRange | null;
  /** #88: drag-to-select - when absent the strip stays seek-only. */
  onSelect?(range: SelectionRange): void;
  /** #113: armed media A-B loop (seconds) - painted as a second band. */
  loop?: SelectionRange | null;
  /** #113: context action - arm/clear the A-B loop on this range. */
  onLoopSelection?(range: SelectionRange): void;
  /** #113: context action - play [start, end) once, then pause. */
  onPlaySelection?(range: SelectionRange): void;
  /** #113: context action / Esc - drop the committed selection. */
  onClearSelection?(): void;
  /** #376: open review issues as strip markers — startSec in source
   *  seconds; click/Enter jumps to the issue (single selection
   *  source: the workspace's review cursor). */
  markers?: readonly WaveformMarker[];
  onMarkerClick?(index: number): void;
}) {
  const duration = audio?.durationSeconds ?? 0;

  // spec 15: the zoom window lives inside the strip - it resets whenever a
  // different clip loads (identity change), never mid-gesture.
  const [view, setView] = useState<ViewRange>(() => fullView(duration));
  const audioRef = useRef(audio);
  if (audioRef.current !== audio) {
    audioRef.current = audio;
    // §26 session restore: reopening the same clip brings back the
    // zoomed window the user left; a different clip starts full.
    const restored =
      audio != null
        ? readWaveformView(audio.fileName, audio.durationSeconds)
        : null;
    setView(restored ?? fullView(duration));
  }

  // Persist the zoom window per source (debounced — wheel zooms fire in
  // bursts). A full view clears the stored entry so a re-open starts
  // full instead of restoring a stale window.
  useEffect(() => {
    if (audio == null || duration <= 0) return;
    const fileName = audio.fileName;
    const durationSeconds = audio.durationSeconds;
    const timer = window.setTimeout(() => {
      writeWaveformView(
        fileName,
        durationSeconds,
        isFullView(view, durationSeconds) ? null : view,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [audio, view, duration]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  // Ctrl+wheel zoom / wheel pan need preventDefault, so the listener is
  // attached non-passively (React registers wheel handlers as passive).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dur = durationRef.current;
      if (dur <= 0) return;
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = clientXInView(e.clientX, rect.left, rect.width, viewRef.current);
        const factor = e.deltaY < 0 ? 0.8 : 1.25;
        setView(zoomView(viewRef.current, anchor, factor, dur));
        return;
      }
      if (isFullView(viewRef.current, dur)) return;
      e.preventDefault();
      const span = viewRef.current.endSec - viewRef.current.startSec;
      const deltaPx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setView(panView(viewRef.current, (deltaPx / Math.max(1, rect.width)) * span, dur));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const visiblePeaks = useMemo(
    () => (audio ? peaksInView(audio.peaks, view, duration) : []),
    [audio, view, duration],
  );
  const path = useMemo(() => peaksPath(visiblePeaks), [visiblePeaks]);

  // #376: review-issue markers — clustered so dense detections stay
  //  one reachable tick each (listbox semantics: ←→ moves, Enter jumps).
  const markerClusters = useMemo(
    () => clusterMarkers(markers ?? [], view, 0.012),
    [markers, view],
  );
  const [markerActive, setMarkerActive] = useState(-1);
  const activeMarker = Math.min(markerActive, markerClusters.length - 1);
  const onMarkersKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = markerClusters.length;
    if (n === 0) return;
    let next = activeMarker;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = activeMarker < 0 ? 0 : Math.min(n - 1, activeMarker + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = activeMarker < 0 ? n - 1 : Math.max(0, activeMarker - 1);
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = n - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      if (activeMarker >= 0) {
        e.preventDefault();
        e.stopPropagation();
        onMarkerClick?.(markerClusters[activeMarker].items[0].index);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setMarkerActive(next);
  };

  const span = view.endSec - view.startSec;
  const ratio =
    positionSec != null && span > 0 &&
    positionSec >= view.startSec && positionSec <= view.endSec
      ? Math.min(1, Math.max(0, (positionSec - view.startSec) / span))
      : null;

  // #88: drag gesture - a press+release under DRAG_THRESHOLD_PX stays a
  // click (seek); past it the gesture becomes a range selection.
  const [dragRange, setDragRange] = useState<SelectionRange | null>(null);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startSec: number;
    rect: DOMRect;
    dragging: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audio || duration <= 0 || e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const g = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startSec: clientXInView(e.clientX, rect.left, rect.width, viewRef.current),
      rect,
      dragging: false,
    };
    gesture.current = g;
    const move = (ev: PointerEvent) => {
      if (gesture.current !== g || ev.pointerId !== g.pointerId) return;
      if (!g.dragging) {
        if (Math.abs(ev.clientX - g.startX) < DRAG_THRESHOLD_PX) return;
        if (!onSelect) return; // seek-only strip: drags do nothing
        g.dragging = true;
      }
      const sec = clientXInView(
        ev.clientX,
        g.rect.left,
        g.rect.width,
        viewRef.current,
      );
      setDragRange(normalizeSelection(g.startSec, sec, duration));
    };
    const finish = (commit: boolean) => (ev: PointerEvent) => {
      if (gesture.current !== g || ev.pointerId !== g.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      gesture.current = null;
      if (g.dragging) {
        setDragRange(null);
        if (commit && onSelect) {
          const sec = clientXInView(
            ev.clientX,
            g.rect.left,
            g.rect.width,
            viewRef.current,
          );
          onSelect(normalizeSelection(g.startSec, sec, duration));
        }
      } else if (commit && onSeek) {
        onSeek(g.startSec);
      }
    };
    const onUp = finish(true);
    const onCancel = finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // #113: edge handles on the committed band - dragging one edge keeps the
  // other anchored and re-commits through onSelect.
  const onHandleDown = (edge: "start" | "end") =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!selection || !onSelect || e.button !== 0) return;
      e.stopPropagation();
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointerId = e.pointerId;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const sec = clientXInView(ev.clientX, rect.left, rect.width, viewRef.current);
        const next =
          edge === "start"
            ? normalizeSelection(sec, selection.endSec, duration)
            : normalizeSelection(selection.startSec, sec, duration);
        onSelect(next);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

  const liveBand = selectionBandInView(dragRange, view);
  const committedBand = selectionBandInView(selection ?? null, view);
  const band = liveBand ?? committedBand;
  const bandRange = dragRange ?? selection ?? null;
  const loopBand = selectionBandInView(loop ?? null, view);
  const zoomed = !isFullView(view, duration);

  const clearCommitted = () => {
    onClearSelection?.();
  };

  // #116 (spec 8): minimap — long clips (>=5 min) or any zoomed view.
  // Click/drag centres the zoom window (or seeks when zoomed out);
  // arrow keys do the same for keyboard users.
  const showMinimap =
    audio != null &&
    duration > 0 &&
    (duration >= MINIMAP_MIN_DURATION_SEC || zoomed);
  const miniPeaks = useMemo(
    () => (audio ? minimapPeaks(audio.peaks, MINIMAP_COLUMNS) : []),
    [audio],
  );
  const miniPath = useMemo(() => peaksPath(miniPeaks), [miniPeaks]);
  const miniViewBand =
    zoomed && duration > 0
      ? { left: view.startSec / duration, width: span / duration }
      : null;
  const miniPlayheadRatio =
    positionSec != null && duration > 0
      ? Math.min(1, Math.max(0, positionSec / duration))
      : null;

  const onMinimapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audio || duration <= 0 || e.button !== 0) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pointerId = e.pointerId;
    const apply = (clientX: number) => {
      const sec = clientXToSeconds(clientX, rect.left, rect.width, duration);
      if (isFullView(viewRef.current, duration)) onSeek?.(sec);
      else setView(centerViewAt(viewRef.current, sec, duration));
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) apply(ev.clientX);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onMinimapKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!audio || duration <= 0) return;
    const step = Math.max(1, duration * 0.05);
    const v = viewRef.current;
    const zoomedNow = !isFullView(v, duration);
    const moveView = (deltaSec: number) =>
      setView(panView(v, deltaSec, duration));
    const movePlayhead = (sec: number) => {
      const clamped = Math.min(Math.max(sec, 0), duration);
      if (zoomedNow) setView(centerViewAt(v, clamped, duration));
      else onSeek?.(clamped);
    };
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        if (zoomedNow) moveView(-step);
        else movePlayhead((positionSec ?? 0) - step);
        break;
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        if (zoomedNow) moveView(step);
        else movePlayhead((positionSec ?? 0) + step);
        break;
      case "PageUp":
        e.preventDefault();
        e.stopPropagation();
        if (zoomedNow) moveView(-step * 4);
        else movePlayhead((positionSec ?? 0) - step * 4);
        break;
      case "PageDown":
        e.preventDefault();
        e.stopPropagation();
        if (zoomedNow) moveView(step * 4);
        else movePlayhead((positionSec ?? 0) + step * 4);
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        movePlayhead(0);
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        movePlayhead(duration);
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={[
        "hs-waveform",
        onSelect ? "hs-waveform--selectable" : null,
        showMinimap ? "hs-waveform--minimap" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      role="region"
      aria-label={ja.waveform.regionLabel}
      data-hs-focus-zone="waveform"
      tabIndex={0}
      style={{ height }}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        // spec 8: Esc clears the committed selection first, then zoom.
        if (e.key !== "Escape") return;
        if (selection) {
          e.stopPropagation();
          clearCommitted();
        } else if (zoomed) {
          e.stopPropagation();
          setView(fullView(duration));
        }
      }}
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
          {" - "}
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
            viewBox={`0 0 ${Math.max(1, visiblePeaks.length)} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={path} />
          </svg>
          {loopBand ? (
            <div
              className="hs-waveform__loop"
              style={{
                left: loopBand.left * 100 + "%",
                width: loopBand.width * 100 + "%",
              }}
              aria-hidden="true"
            />
          ) : null}
          {band ? (
            <div
              className={liveBand
                ? "hs-waveform__selection hs-waveform__selection--live"
                : "hs-waveform__selection"}
              style={{
                left: band.left * 100 + "%",
                width: band.width * 100 + "%",
              }}
              aria-hidden="true"
            >
              {bandRange ? (
                <span className="hs-waveform__selection-label">
                  {formatTimecode(bandRange.startSec)}
                  {" - "}
                  {formatTimecode(bandRange.endSec)}
                </span>
              ) : null}
            </div>
          ) : null}
          {/* #113: edge handles on the committed band only - the live
              preview is already following the pointer. */}
          {committedBand && !liveBand && onSelect ? (
            <>
              <div
                className="hs-waveform__handle hs-waveform__handle--start"
                style={{ left: `calc(${committedBand.left * 100}% - 4px)` }}
                onPointerDown={onHandleDown("start")}
              />
              <div
                className="hs-waveform__handle hs-waveform__handle--end"
                style={{
                  left: `calc(${(committedBand.left + committedBand.width) * 100}% - 4px)`,
                }}
                onPointerDown={onHandleDown("end")}
              />
            </>
          ) : null}
          {ratio !== null ? (
            <div
              className="hs-waveform__playhead"
              style={{ left: `${ratio * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
          {/* #376: open review issues — a listbox strip of ticks along
              the top edge; Enter/click jumps via the workspace's own
              review cursor (one selection source). */}
          {markerClusters.length > 0 ? (
            <div
              className="hs-waveform__markers"
              role="listbox"
              aria-label={ja.waveform.reviewMarkers}
              aria-orientation="horizontal"
              aria-activedescendant={
                activeMarker >= 0
                  ? `hs-wavemarker-${activeMarker}`
                  : undefined
              }
              tabIndex={0}
              onKeyDown={onMarkersKey}
            >
              {markerClusters.map((c, i) => (
                <div
                  key={i}
                  id={`hs-wavemarker-${i}`}
                  role="option"
                  aria-selected={i === activeMarker}
                  aria-label={c.label}
                  title={c.label}
                  className={[
                    "hs-waveform__marker",
                    `hs-waveform__marker--${c.severity}`,
                    i === activeMarker
                      ? "hs-waveform__marker--active"
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: `${c.pos * 100}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setMarkerActive(i);
                    onMarkerClick?.(c.items[0].index);
                  }}
                >
                  {c.items.length > 1 ? (
                    <span
                      className="hs-waveform__marker-count"
                      aria-hidden="true"
                    >
                      {c.items.length}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <span className="hs-waveform__name" aria-hidden="true">
            {audio.fileName}
          </span>
          {/* #113: context actions for the committed selection (spec 8). */}
          {committedBand && !liveBand ? (
            <div
              className="hs-waveform__actions"
              role="toolbar"
              aria-label={ja.waveform.selectionActions}
              style={{
                left: `${Math.min(
                  96,
                  (committedBand.left + committedBand.width) * 100,
                )}%`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Tooltip content={ja.waveform.loopSelection} relationship="label">
                <button
                  type="button"
                  className="hs-waveform__action"
                  aria-label={ja.waveform.loopSelection}
                  onClick={() =>
                    selection && onLoopSelection?.(selection)
                  }
                >
                  <ArrowRepeatAll24Regular />
                </button>
              </Tooltip>
              <Tooltip content={ja.waveform.playSelection} relationship="label">
                <button
                  type="button"
                  className="hs-waveform__action"
                  aria-label={ja.waveform.playSelection}
                  onClick={() =>
                    selection && onPlaySelection?.(selection)
                  }
                >
                  <Play24Regular />
                </button>
              </Tooltip>
              <Tooltip content={ja.waveform.zoomSelection} relationship="label">
                <button
                  type="button"
                  className="hs-waveform__action"
                  aria-label={ja.waveform.zoomSelection}
                  onClick={() =>
                    selection &&
                    setView(clampView(selection, duration))
                  }
                >
                  <ZoomIn24Regular />
                </button>
              </Tooltip>
              <Tooltip content={ja.waveform.clearSelection} relationship="label">
                <button
                  type="button"
                  className="hs-waveform__action"
                  aria-label={ja.waveform.clearSelection}
                  onClick={clearCommitted}
                >
                  <Dismiss24Regular />
                </button>
              </Tooltip>
            </div>
          ) : null}
          {/* #113: zoomed-state chip - one click back to the whole clip. */}
          {zoomed ? (
            <Tooltip content={ja.waveform.resetZoom} relationship="label">
              <button
                type="button"
                className="hs-waveform__zoom-reset"
                aria-label={ja.waveform.resetZoom}
                onClick={() => setView(fullView(duration))}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <ZoomFit24Regular />
                <span>{ja.waveform.zoomedLabel}</span>
              </button>
            </Tooltip>
          ) : null}
        </>
      ) : (
        <span className="hs-waveform__placeholder">
          {ja.waveform.placeholder}
        </span>
      )}
      {/* #116 (spec 8): minimap — whole-clip strip with the zoom window
          as a band; click/drag/keys navigate. Long clips or zoomed only. */}
      {showMinimap ? (
        <div
          className="hs-waveform__minimap"
          role="slider"
          aria-label={ja.waveform.minimap}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(
            zoomed ? view.startSec : (positionSec ?? 0),
          )}
          aria-valuetext={formatTimecode(
            zoomed ? view.startSec : (positionSec ?? 0),
          )}
          tabIndex={0}
          onPointerDown={onMinimapDown}
          onKeyDown={onMinimapKey}
        >
          <svg
            className="hs-waveform__minimap-peaks"
            viewBox={`0 0 ${Math.max(1, miniPeaks.length)} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={miniPath} />
          </svg>
          {miniViewBand ? (
            <div
              className="hs-waveform__minimap-window"
              style={{
                left: `${miniViewBand.left * 100}%`,
                width: `${Math.max(0.5, miniViewBand.width * 100)}%`,
              }}
              aria-hidden="true"
            />
          ) : null}
          {miniPlayheadRatio !== null ? (
            <div
              className="hs-waveform__minimap-playhead"
              style={{ left: `${miniPlayheadRatio * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
          {/* #376: issue ticks on the minimap too — the whole-clip
              problem distribution stays visible while zoomed. These
              are display-only; the minimap keeps its own slider nav. */}
          {markers != null && duration > 0
            ? markers.map((m, i) =>
                m.startSec >= 0 && m.startSec <= duration ? (
                  <div
                    key={i}
                    className={`hs-waveform__minimap-marker hs-waveform__marker--${m.severity}`}
                    style={{ left: `${(m.startSec / duration) * 100}%` }}
                    aria-hidden="true"
                  />
                ) : null,
              )
            : null}
        </div>
      ) : null}
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
          // Keep the resize gesture out of the strip's select/seek
          // pointerdown (it bubbles up to .hs-waveform otherwise).
          e.stopPropagation();
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
