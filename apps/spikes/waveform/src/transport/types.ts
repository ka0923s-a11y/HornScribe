/**
 * TransportController contract for HornScribe (UI-004 spike).
 *
 * Mirrors docs/MASTER_PLAN.md §10 (`interface TransportController`) with the
 * spike additions needed to exercise the surface (load/stop/preservePitch/
 * dispose). HornScribe owns this interface: wavesurfer.js and
 * HTMLMediaElement are adapters/views, never the business-logic source of
 * truth. The authoritative clock is the audio clock exposed through
 * getCurrentTime(), not React state and not the waveform view.
 */

/** Half-open time range in seconds: [start, end). */
export interface TimeRange {
  start: number
  end: number
}

export type TransportStatus =
  | 'empty' // nothing loaded
  | 'loading' // load requested, not yet ready
  | 'ready' // loaded, cursor parked
  | 'playing'
  | 'paused'
  | 'ended' // reached end of media while playing
  | 'error'

export interface TransportSnapshot {
  status: TransportStatus
  /** Audio-clock time in seconds. Low-frequency mirror — see getCurrentTime(). */
  time: number
  /** Duration in seconds (0 while empty/loading). */
  duration: number
  /** Playback rate multiplier. */
  rate: number
  /** Whether pitch preservation is requested for rate != 1. */
  preservePitch: boolean
  /** Active A-B loop range, or null when looping is off. */
  loop: TimeRange | null
  /** Monotonic counter bumped on every emitted snapshot. */
  revision: number
}

export type TransportListener = (snapshot: TransportSnapshot) => void
export type Unsubscribe = () => void

/** Source the transport can load. */
export type AudioSource = { kind: 'url'; url: string } | { kind: 'blob'; blob: Blob }

export interface LoopWrapInfo {
  /** Loop end the playhead was supposed to wrap at (seconds). */
  expected: number
  /** Audio-clock time observed when the wrap check fired (seconds). */
  actual: number
  /** actual - expected: overshoot past the loop end before wrapping. */
  overshoot: number
}

export interface TransportController {
  /** Load a source. Resolves when decoded + ready to play. */
  load(source: AudioSource): Promise<void>
  play(): Promise<void>
  pause(): void
  /** Pause and return to t=0 (or the loop start when a loop is armed). */
  stop(): void
  /** Seek to an absolute position in seconds. Clamped to [0, duration]. */
  seek(seconds: number): Promise<void>
  /** Set playback rate. Spike accepts [MIN_RATE..MAX_RATE], clamped. */
  setRate(rate: number): void
  /** Request pitch preservation for rate != 1 (where the backend supports it). */
  setPreservePitch(on: boolean): void
  /** Arm (TimeRange) or clear (null) the A-B loop. */
  setLoop(range: TimeRange | null): void
  /** Authoritative audio-clock time in seconds. Read on demand (rAF ok). */
  getCurrentTime(): number
  getDuration(): number
  getSnapshot(): TransportSnapshot
  subscribe(listener: TransportListener): Unsubscribe
  dispose(): void
}

export const MIN_RATE = 0.25
export const MAX_RATE = 4
export const SUPPORTED_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const
/** Loops shorter than this are rejected (noise-level accidental drags). */
export const MIN_LOOP_SECONDS = 0.01
