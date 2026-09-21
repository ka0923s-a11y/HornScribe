import type { MediaPort } from './core'

/**
 * Deterministic MediaPort for headless tests: the "audio clock" is a manual
 * cursor that the test advances with advance(). No DOM, no timers.
 */
export class FakeMediaPort implements MediaPort {
  time = 0
  duration = 0
  rate = 1
  preservePitch = true
  playing = false
  playCalls = 0
  pauseCalls = 0
  /** Every seek target, in order. */
  seeks: number[] = []

  constructor(duration = 60) {
    this.duration = duration
  }

  play(): Promise<void> {
    this.playCalls += 1
    this.playing = true
    return Promise.resolve()
  }

  pause(): void {
    this.pauseCalls += 1
    this.playing = false
  }

  seekTo(seconds: number): void {
    this.seeks.push(seconds)
    this.time = seconds
  }

  setRate(rate: number): void {
    this.rate = rate
  }

  setPreservePitch(on: boolean): void {
    this.preservePitch = on
  }

  getTime(): number {
    return this.time
  }

  getDuration(): number {
    return this.duration
  }

  /** Advance the fake audio clock as if playback ran `dt` seconds. */
  advance(dt: number): void {
    this.time += dt * this.rate
  }
}
