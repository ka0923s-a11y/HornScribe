/**
 * Transport clock abstraction for the score workspace (UI-030).
 *
 * The score UI never reads wall time directly — it reads a TransportClock.
 * Until the audio engine/media element lands (UI-020/UI-040 wiring), the
 * workspace runs on `ScoreCursorClock`: a deterministic rAF-driven clock
 * that advances through the score's own notated duration. The same port
 * later binds to the media clock, keeping the UI-005 "one clock" contract —
 * view switches, highlights and follow logic never know the difference.
 */

export interface LoopRange {
  startMs: number;
  endMs: number;
}

export interface ClockSnapshot {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly isPlaying: boolean;
  readonly rate: number;
  readonly loop: LoopRange | null;
}

export interface TransportClock {
  positionMs(): number;
  durationMs(): number;
  isPlaying(): boolean;
  rate(): number;
  loopRange(): LoopRange | null;
  play(): void;
  pause(): void;
  togglePlayPause(): void;
  stop(): void;
  seek(ms: number): void;
  jumpBy(deltaMs: number): void;
  setLoop(range: LoopRange | null): void;
  setRate(rate: number): void;
  /** #170: score edits change the notated length — keep the clock's
   *  total span in step (clamps position + loop into the new range). */
  setDuration(ms: number): void;
  /** Throttled state mirror (~10 Hz + every transition). */
  subscribe(cb: (s: ClockSnapshot) => void): () => void;
  dispose(): void;
}

const SNAPSHOT_INTERVAL_MS = 100;

/**
 * Deterministic rAF clock over a fixed score duration. No audio output —
 * it is the score-side playback position until real audio wiring arrives;
 * the semantics (seek/loop/rate/subscribe) match the media-clock contract
 * used by the UI-005 spike so nothing in the view layer changes then.
 */
export class ScoreCursorClock implements TransportClock {
  private pos = 0;
  private dur: number;
  private playing = false;
  private playbackRate = 1;
  private loop: LoopRange | null = null;
  private raf = 0;
  private lastTick = 0;
  private lastSnapshotAt = 0;
  private readonly subs = new Set<(s: ClockSnapshot) => void>();
  private disposed = false;
  private readonly rafFn: (cb: (t: number) => void) => number;
  private readonly cafFn: (id: number) => void;

  constructor(
    durationMs: number,
    opts: {
      raf?: (cb: (t: number) => void) => number;
      caf?: (id: number) => void;
    } = {},
  ) {
    this.dur = Math.max(0, durationMs);
    this.rafFn = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.cafFn = opts.caf ?? ((id) => cancelAnimationFrame(id));
  }

  positionMs(): number {
    return this.pos;
  }

  durationMs(): number {
    return this.dur;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  rate(): number {
    return this.playbackRate;
  }

  loopRange(): LoopRange | null {
    return this.loop;
  }

  play(): void {
    if (this.playing || this.disposed) return;
    if (this.pos >= this.dur) this.pos = 0;
    this.playing = true;
    this.lastTick = 0;
    this.schedule();
    this.emit(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.raf) {
      this.cafFn(this.raf);
      this.raf = 0;
    }
    this.emit(true);
  }

  togglePlayPause(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  stop(): void {
    this.pause();
    this.pos = 0;
    this.emit(true);
  }

  seek(ms: number): void {
    this.pos = Math.min(this.dur, Math.max(0, ms));
    this.emit(true);
  }

  jumpBy(deltaMs: number): void {
    this.seek(this.pos + deltaMs);
  }

  setLoop(range: LoopRange | null): void {
    this.loop =
      range && range.endMs > range.startMs
        ? {
            startMs: Math.max(0, range.startMs),
            endMs: Math.min(this.dur, range.endMs),
          }
        : null;
    if (this.loop && this.loop.endMs <= this.loop.startMs) this.loop = null;
    this.emit(true);
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.playbackRate = rate;
    this.emit(true);
  }

  setDuration(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.dur = ms;
    if (this.pos > this.dur) this.pos = this.dur;
    if (this.loop) {
      this.setLoop(this.loop); // re-clamps / drops an out-of-range loop
      return; // setLoop already emitted
    }
    this.emit(true);
  }

  subscribe(cb: (s: ClockSnapshot) => void): () => void {
    this.subs.add(cb);
    cb(this.snapshot());
    return () => this.subs.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    if (this.raf) {
      this.cafFn(this.raf);
      this.raf = 0;
    }
    this.subs.clear();
  }

  private schedule(): void {
    this.raf = this.rafFn((t) => this.tick(t));
  }

  private tick(now: number): void {
    if (!this.playing || this.disposed) return;
    if (this.lastTick !== 0) {
      const dt = (now - this.lastTick) * this.playbackRate;
      this.pos += dt;
      const loop = this.loop;
      if (loop && this.pos >= loop.endMs) {
        // Wrap inside the loop range, carrying the overshoot.
        this.pos = loop.startMs + ((this.pos - loop.startMs) % (loop.endMs - loop.startMs));
      } else if (this.pos >= this.dur) {
        this.pos = this.dur;
        this.playing = false;
        this.emit(true);
        return;
      }
    }
    this.lastTick = now;
    this.emit(false);
    this.schedule();
  }

  private snapshot(): ClockSnapshot {
    return {
      positionMs: this.pos,
      durationMs: this.dur,
      isPlaying: this.playing,
      rate: this.playbackRate,
      loop: this.loop ? { ...this.loop } : null,
    };
  }

  /** Emit on every transition, and at most every SNAPSHOT_INTERVAL_MS while
   *  running — the React mirror stays ~10 Hz, never 60 Hz (UI-005 budget). */
  private emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    this.lastSnapshotAt = now;
    const s = this.snapshot();
    for (const cb of this.subs) cb(s);
  }
}
