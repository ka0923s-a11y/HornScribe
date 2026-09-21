import {
  MAX_RATE,
  MIN_LOOP_SECONDS,
  MIN_RATE,
  type LoopWrapInfo,
  type TimeRange,
  type TransportListener,
  type TransportSnapshot,
  type TransportStatus,
  type Unsubscribe,
} from './types'

/**
 * Minimal media engine surface the TransportCore drives.
 * Implemented by WaveSurferTransportAdapter (wavesurfer/HTMLMediaElement)
 * and by FakeMediaPort in tests. This is the adapter boundary the product
 * keeps: swap the engine without touching transport logic.
 */
export interface MediaPort {
  play(): Promise<void> | void
  pause(): void
  /** Absolute seek in seconds. Implementations must clamp to media bounds. */
  seekTo(seconds: number): void
  setRate(rate: number): void
  setPreservePitch(on: boolean): void
  /** Authoritative audio clock, seconds. May be NaN before load. */
  getTime(): number
  /** Media duration in seconds. 0/NaN while unknown. */
  getDuration(): number
}

export interface TransportCoreOptions {
  /**
   * Minimum audio-clock advance (seconds) before a time-only snapshot is
   * emitted from onTick(). Keeps listeners (e.g. React state) off the
   * per-frame path; the clock itself is always available via getTime().
   */
  timeEmitInterval?: number
  /** Called after every loop wrap with the observed boundary times. */
  onLoopWrap?: (info: LoopWrapInfo) => void
}

const DEFAULT_TIME_EMIT_INTERVAL = 0.1

/**
 * HornScribe-owned transport state machine. Headless and DOM-free:
 * the MediaPort supplies the clock and playback, this class owns policy —
 * clamping, status transitions, and A-B loop enforcement.
 *
 * Loop semantics (documented for the spike):
 *  - loop = half-open [start, end); while playing, reaching `end` wraps to `start`.
 *  - an explicit seek() landing outside the armed loop disarms enforcement
 *    until the playhead re-enters [start, end) — the user can escape the loop
 *    without clearing it.
 *  - setLoop(null) clears immediately; the next wrap never happens.
 */
export class TransportCore {
  private port: MediaPort
  private listeners = new Set<TransportListener>()
  private opts: Required<Pick<TransportCoreOptions, 'timeEmitInterval'>> & TransportCoreOptions

  private status: TransportStatus = 'empty'
  private duration = 0
  private time = 0
  private lastEmittedTime = 0
  private rate = 1
  private preservePitch = true
  private loop: TimeRange | null = null
  /** Whether loop-end enforcement currently applies. See class doc. */
  private loopArmed = false
  private revision = 0

  constructor(port: MediaPort, opts: TransportCoreOptions = {}) {
    this.port = port
    this.opts = { timeEmitInterval: opts.timeEmitInterval ?? DEFAULT_TIME_EMIT_INTERVAL, ...opts }
  }

  // ---- queries -----------------------------------------------------------

  getSnapshot(): TransportSnapshot {
    return {
      status: this.status,
      time: this.time,
      duration: this.duration,
      rate: this.rate,
      preservePitch: this.preservePitch,
      loop: this.loop ? { ...this.loop } : null,
      revision: this.revision,
    }
  }

  getTime(): number {
    const t = this.port.getTime()
    return Number.isFinite(t) ? t : this.time
  }

  getDuration(): number {
    return this.duration
  }

  isPlaying(): boolean {
    return this.status === 'playing'
  }

  isLoopArmed(): boolean {
    return this.loopArmed
  }

  // ---- lifecycle (called by the adapter's engine events) -----------------

  onLoadStart(): void {
    this.status = 'loading'
    this.duration = 0
    this.time = 0
    this.lastEmittedTime = 0
    this.loop = null
    this.loopArmed = false
    this.emit()
  }

  onLoaded(duration: number): void {
    this.duration = Number.isFinite(duration) ? Math.max(0, duration) : 0
    this.status = 'ready'
    this.time = 0
    this.emit()
  }

  onPlayStart(): void {
    if (this.status !== 'playing') {
      this.status = 'playing'
      this.emit()
    }
  }

  onPaused(): void {
    if (this.status === 'playing') {
      this.status = 'paused'
      this.time = this.getTime()
      this.emit()
    }
  }

  onEnded(): void {
    this.status = 'ended'
    this.time = this.getTime()
    this.emit()
  }

  onError(): void {
    this.status = 'error'
    this.emit()
  }

  // ---- commands ----------------------------------------------------------

  async play(): Promise<void> {
    if (this.status === 'empty' || this.status === 'loading' || this.status === 'error') return
    if (this.status === 'ended') {
      this.seekInternal(0)
    }
    this.status = 'playing'
    this.emit()
    await this.port.play()
  }

  pause(): void {
    if (this.status !== 'playing') return
    this.port.pause()
    this.status = 'paused'
    this.time = this.getTime()
    this.emit()
  }

  stop(): void {
    if (this.status === 'empty' || this.status === 'loading') return
    if (this.status === 'playing') this.port.pause()
    this.status = 'paused'
    this.seekInternal(this.loop ? this.loop.start : 0)
    this.emit()
  }

  async seek(seconds: number): Promise<void> {
    if (this.status === 'empty' || this.status === 'loading') return
    const t = this.clampTime(seconds)
    // An explicit user seek outside the armed loop disarms enforcement until
    // the playhead re-enters the range (see class doc).
    if (this.loopArmed && this.loop && !this.inLoop(t)) {
      this.loopArmed = false
    }
    if (this.loop && !this.loopArmed && this.inLoop(t)) {
      this.loopArmed = true
    }
    this.seekInternal(t)
    this.emit()
    if (this.status === 'ended') {
      this.status = 'paused'
      this.emit()
    }
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate)) return
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, rate))
    if (clamped === this.rate) return
    this.rate = clamped
    this.port.setRate(clamped)
    this.emit()
  }

  setPreservePitch(on: boolean): void {
    if (on === this.preservePitch) return
    this.preservePitch = on
    this.port.setPreservePitch(on)
    this.emit()
  }

  /**
   * Arm or clear the A-B loop. Returns false when the range is unusable
   * (inverted, shorter than MIN_LOOP_SECONDS, or outside the media).
   */
  setLoop(range: TimeRange | null): boolean {
    if (range === null) {
      if (this.loop === null) return false
      this.loop = null
      this.loopArmed = false
      this.emit()
      return true
    }
    const normalized = this.normalizeRange(range)
    if (normalized === null) return false
    this.loop = normalized
    this.loopArmed = this.inLoop(this.getTime())
    this.emit()
    return true
  }

  // ---- clock path --------------------------------------------------------

  /**
   * Called by the adapter's clock pump (rAF while playing, plus on seek/
   * media events). Reads the audio clock and enforces the loop boundary.
   */
  onTick(): void {
    const t = this.getTime()
    const prev = this.time
    this.time = t

    if (this.status === 'playing' && this.loop && this.loopArmed && t >= this.loop.end) {
      const info: LoopWrapInfo = { expected: this.loop.end, actual: t, overshoot: t - this.loop.end }
      const start = this.loop.start
      this.port.seekTo(start)
      this.time = start
      this.opts.onLoopWrap?.(info)
      this.emit()
      return
    }

    // Re-arm once the playhead is inside the loop range again.
    if (this.loop && !this.loopArmed && this.inLoop(t)) {
      this.loopArmed = true
    }

    if (this.status === 'playing' && this.duration > 0 && t >= this.duration) {
      this.status = 'ended'
      this.emit()
      return
    }

    // Throttle time-only emissions; mutations elsewhere emit immediately.
    if (Math.abs(t - this.lastEmittedTime) >= this.opts.timeEmitInterval || t < prev) {
      this.emit()
    }
  }

  // ---- subscriptions -----------------------------------------------------

  subscribe(listener: TransportListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.revision += 1
    this.lastEmittedTime = this.time
    const snapshot = this.getSnapshot()
    for (const l of this.listeners) l(snapshot)
  }

  // ---- internals ---------------------------------------------------------

  private seekInternal(t: number): void {
    this.port.seekTo(t)
    this.time = t
  }

  private clampTime(t: number): number {
    if (!Number.isFinite(t)) return 0
    const upper = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY
    return Math.min(upper, Math.max(0, t))
  }

  private inLoop(t: number): boolean {
    return this.loop !== null && t >= this.loop.start && t < this.loop.end
  }

  private normalizeRange(range: TimeRange): TimeRange | null {
    const { start, end } = range
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    const s = Math.max(0, start)
    const e = this.duration > 0 ? Math.min(this.duration, end) : end
    if (e - s < MIN_LOOP_SECONDS) return null
    return { start: s, end: e }
  }
}
