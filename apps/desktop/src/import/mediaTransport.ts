/**
 * Minimal TransportController adapter for the AUDIO_READY state (UI-020),
 * consistent with the UI-004 spike contract
 * (apps/spikes/waveform/src/transport/types.ts).
 *
 * HornScribe owns this contract: the HTMLMediaElement is an adapter behind
 * `MediaPort`, the audio clock (`getCurrentTime`) is authoritative, and
 * snapshots are emitted to subscribers on state changes and media
 * timeupdate ticks (media-element cadence ≈4 Hz — no rAF, no 60 Hz
 * React churn; the full UI-004 pipeline with its rAF pump/Regions lands
 * with the real waveform view).
 *
 * A-B loop semantics mirror the spike: `[start, end)` wraps via a media
 * seek, which costs a small audible gap — the documented MediaElement
 * constraint, accepted here for the import-stage adapter.
 */
import type { MediaSource } from "./types";

export type TransportStatus =
  | "empty"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

/** Half-open time range in seconds: [start, end). */
export interface TimeRange {
  start: number;
  end: number;
}

export interface TransportSnapshot {
  status: TransportStatus;
  /** Audio-clock time in seconds (low-frequency mirror; use getCurrentTime
      for per-frame reads). */
  time: number;
  duration: number;
  rate: number;
  loop: TimeRange | null;
  /** Monotonic counter bumped on every emitted snapshot. */
  revision: number;
}

export type TransportListener = (snapshot: TransportSnapshot) => void;
export type Unsubscribe = () => void;

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
export const SUPPORTED_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;
/** Loops shorter than this are rejected (noise-level accidental drags). */
export const MIN_LOOP_SECONDS = 0.01;

/** Event feed the port must surface to the adapter. */
export interface MediaPortHandlers {
  onTimeUpdate?(): void;
  onEnded?(): void;
  onError?(): void;
}

/**
 * The media backend seam (UI-004 spike naming). `load` resolves when the
 * source is decoded enough to report a duration and accept play().
 */
export interface MediaPort {
  load(source: MediaSource): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seekTo(seconds: number): void;
  setRate(rate: number): void;
  setPreservePitch(on: boolean): void;
  getTime(): number;
  getDuration(): number;
  subscribe(handlers: MediaPortHandlers): Unsubscribe;
}

/* ---------------------- HTMLAudioElement backend ---------------------- */

class AudioElementMediaPort implements MediaPort {
  private readonly el: HTMLAudioElement;
  private objectUrl: string | null = null;
  private readonly handlers = new Set<MediaPortHandlers>();

  constructor(el?: HTMLAudioElement) {
    this.el = el ?? new Audio();
    this.el.preload = "auto";
    this.el.addEventListener("timeupdate", () => this.emit("onTimeUpdate"));
    this.el.addEventListener("ended", () => this.emit("onEnded"));
    this.el.addEventListener("error", () => this.emit("onError"));
  }

  private emit(key: keyof MediaPortHandlers) {
    for (const h of this.handlers) h[key]?.();
  }

  load(source: MediaSource): Promise<void> {
    this.revoke();
    const url =
      source.kind === "url"
        ? source.url
        : ((this.objectUrl = URL.createObjectURL(source.blob)), this.objectUrl);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.el.removeEventListener("loadedmetadata", ok);
        this.el.removeEventListener("error", ng);
      };
      const ok = () => {
        cleanup();
        resolve();
      };
      const ng = () => {
        cleanup();
        reject(new Error("media element could not load the source"));
      };
      this.el.addEventListener("loadedmetadata", ok, { once: true });
      this.el.addEventListener("error", ng, { once: true });
      this.el.src = url;
    });
  }

  private revoke() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  play(): Promise<void> {
    return this.el.play();
  }
  pause(): void {
    this.el.pause();
  }
  seekTo(seconds: number): void {
    this.el.currentTime = seconds;
  }
  setRate(rate: number): void {
    this.el.playbackRate = rate;
  }
  setPreservePitch(on: boolean): void {
    // Set the standard property plus the historical vendor-prefixed ones —
    // engines ignore the names they do not implement.
    const el = this.el as HTMLAudioElement & {
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    el.preservesPitch = on;
    el.mozPreservesPitch = on;
    el.webkitPreservesPitch = on;
  }
  getTime(): number {
    return this.el.currentTime;
  }
  getDuration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  subscribe(handlers: MediaPortHandlers): Unsubscribe {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }
}

/* ------------------------------ controller ------------------------------ */

export class MediaElementTransport {
  private readonly port: MediaPort;
  private status: TransportStatus = "empty";
  private rate = 1;
  private loop: TimeRange | null = null;
  private revision = 0;
  private readonly listeners = new Set<TransportListener>();

  constructor(port?: MediaPort) {
    this.port = port ?? new AudioElementMediaPort();
    this.port.subscribe({
      onTimeUpdate: () => {
        if (this.status === "playing" && this.loop) {
          const t = this.port.getTime();
          if (t >= this.loop.end) {
            // A-B wrap via media seek — see doc header for the known
            // ~60 ms MediaElement gap measured in the UI-004 spike.
            this.port.seekTo(this.loop.start);
          }
        }
        this.emit();
      },
      onEnded: () => {
        if (this.status === "playing") {
          this.status = "ended";
          this.emit();
        }
      },
      onError: () => {
        if (this.status !== "empty") {
          this.status = "error";
          this.emit();
        }
      },
    });
  }

  /** Load a source. Resolves when ready to play; rejects → status "error". */
  async load(source: MediaSource): Promise<void> {
    this.status = "loading";
    this.loop = null;
    this.emit();
    try {
      await this.port.load(source);
      this.status = "ready";
    } catch (e) {
      this.status = "error";
      this.emit();
      throw e;
    }
    this.emit();
  }

  async play(): Promise<void> {
    if (this.status === "empty" || this.status === "loading") return;
    if (this.status === "ended") this.port.seekTo(0);
    if (this.status === "playing") return;
    await this.port.play();
    this.status = "playing";
    this.emit();
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.port.pause();
    this.status = "paused";
    this.emit();
  }

  /** Pause and return to t=0 (or the loop start when a loop is armed). */
  stop(): void {
    if (this.status === "empty" || this.status === "loading") return;
    this.port.pause();
    this.port.seekTo(this.loop?.start ?? 0);
    this.status = "ready";
    this.emit();
  }

  /** Seek to an absolute position in seconds, clamped to [0, duration]. */
  async seek(seconds: number): Promise<void> {
    const duration = this.port.getDuration();
    const target = Math.min(Math.max(seconds, 0), duration);
    this.port.seekTo(target);
    if (this.status === "ended") this.status = "paused";
    this.emit();
  }

  /** Playback rate, clamped to [MIN_RATE, MAX_RATE]. */
  setRate(rate: number): void {
    this.rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
    this.port.setRate(this.rate);
    this.emit();
  }

  /** Request pitch preservation for rate != 1 (backend permitting). */
  setPreservePitch(on: boolean): void {
    this.port.setPreservePitch(on);
    this.emit();
  }

  /** Arm (TimeRange) or clear (null) the A-B loop. Degenerate/inverted
      ranges and ranges past the media end are rejected (clamped). */
  setLoop(range: TimeRange | null): void {
    if (range === null) {
      this.loop = null;
      this.emit();
      return;
    }
    const duration = this.port.getDuration();
    const start = Math.max(0, range.start);
    const end = Math.min(duration, range.end);
    if (end - start < MIN_LOOP_SECONDS) return;
    this.loop = { start, end };
    this.emit();
  }

  /** Authoritative audio-clock time — read on demand. */
  getCurrentTime(): number {
    return this.port.getTime();
  }
  getDuration(): number {
    return this.port.getDuration();
  }

  getSnapshot(): TransportSnapshot {
    return {
      status: this.status,
      time: this.port.getTime(),
      duration: this.port.getDuration(),
      rate: this.rate,
      loop: this.loop ? { ...this.loop } : null,
      revision: this.revision,
    };
  }

  subscribe(listener: TransportListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.port.pause();
  }

  private emit(): void {
    this.revision += 1;
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  }
}
