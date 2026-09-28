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
  /** #101: a count-in hold is consuming wall time — the position is
   *  frozen at the entry point while the count-in bar clicks. */
  readonly countingIn: boolean;
  /** #101: remaining count-in budget in score-ms (0 when not counting
   *  in). The audition synth shifts the resume anchor by this so notes
   *  sound only after the hold ends. */
  readonly countInRemainingMs: number;
}

export interface TransportClock {
  positionMs(): number;
  durationMs(): number;
  isPlaying(): boolean;
  rate(): number;
  loopRange(): LoopRange | null;
  /** #101: countInMs holds the position frozen for that much score-time
   *  before playback actually advances (one bar of clicks). */
  play(countInMs?: number): void;
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
  /** #101: remaining count-in budget in score-ms; while > 0 the rAF
   *  delta charges here instead of advancing pos. */
  private holdMs = 0;
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

  play(countInMs = 0): void {
    if (this.playing || this.disposed) return;
    if (this.pos >= this.dur) this.pos = 0;
    this.playing = true;
    this.holdMs = Math.max(0, countInMs);
    this.lastTick = 0;
    this.schedule();
    this.emit(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.holdMs = 0;
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
    this.holdMs = 0; // a seek during the count-in cancels it
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
      let dt = (now - this.lastTick) * this.playbackRate;
      const wasCounting = this.holdMs > 0;
      if (wasCounting) {
        // #101: the hold consumes the delta first; only the leftover
        // flows into the position, so the entry lands on schedule even
        // when the hold ends mid-tick.
        const used = Math.min(dt, this.holdMs);
        this.holdMs -= used;
        dt -= used;
      }
      if (dt > 0) {
        this.pos += dt;
        const loop = this.loop;
        if (loop && this.pos >= loop.endMs) {
          // Wrap inside the loop range, carrying the overshoot.
          this.pos =
            loop.startMs +
            ((this.pos - loop.startMs) % (loop.endMs - loop.startMs));
        } else if (this.pos >= this.dur) {
          this.pos = this.dur;
          this.playing = false;
          this.holdMs = 0;
          this.emit(true);
          return;
        }
      }
      // The count-in end is a transition — the synth must reschedule
      // notes onto the now-moving position without the hold offset.
      this.lastTick = now;
      this.emit(wasCounting && this.holdMs === 0);
      this.schedule();
      return;
    }
    this.lastTick = now;
    this.schedule();
  }

  private snapshot(): ClockSnapshot {
    return {
      positionMs: this.pos,
      durationMs: this.dur,
      isPlaying: this.playing,
      rate: this.playbackRate,
      loop: this.loop ? { ...this.loop } : null,
      countingIn: this.holdMs > 0,
      countInRemainingMs: this.holdMs,
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
