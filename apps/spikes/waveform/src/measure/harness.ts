import type { WaveSurferTransportAdapter } from '../transport/wavesurferAdapter'
import { SUPPORTED_RATES } from '../transport/types'

/**
 * In-page measurement harness for UI-004. All numbers are measured with
 * performance.now() against the media element clock — no "feels smooth".
 * Run from the UI (計測パネル) or via scripts/measure.mjs (puppeteer-core).
 */

export interface SeekStats {
  samples: number
  /** First seek after load — media pipeline cold path. */
  coldSeekMs: number
  medianMs: number
  p95Ms: number
  meanMs: number
  maxMs: number
}

export interface JitterStats {
  frames: number
  /** σ of (audioClockDelta − wallDelta × rate) across consecutive rAF samples. */
  audioDeltaSigmaMs: number
  maxAbsErrMs: number
  /** Mean rAF interval while playing (frame cadence). */
  frameIntervalMeanMs: number
  frameIntervalSigmaMs: number
  /** App component renders during the sample window (no per-frame rerender check). */
  reactRenders: number | null
}

export interface LoopStats {
  wraps: number
  loopStart: number
  loopEnd: number
  rate: number
  /** Wrap overshoot past loop.end on the audio clock. */
  overshootMeanMs: number
  overshootMaxMs: number
  /** Wall-clock loop period vs expected (end−start)/rate — cumulative drift. */
  periodErrMeanMs: number
  periodErrMaxMs: number
  totalDriftMs: number
}

export interface MemoryStats {
  supported: boolean
  beforeLoadMB: number | null
  afterLoadMB: number | null
  duringPlaybackMB: number | null
}

export interface RateStat {
  rate: number
  measuredRate: number
  relErrorPct: number
  preservesPitch: boolean | null
  /** preservesPitch flag observed when setPreservePitch(false) was applied. */
  preservePitchOff: boolean | null
}

export interface FixtureReport {
  fixture: string
  durationSec: number
  loadDecodeMs: number
  loadReadyMs: number
  seek: SeekStats
  jitter: JitterStats
  loop: LoopStats
  memory: MemoryStats
  zoomMeanMs: number
  zoomMaxMs: number
  panMeanMs: number
  panMaxMs: number
  rates: RateStat[]
  peaksJsonBytes: number
  peaksMaxLength: number
}

export interface FullReport {
  tool: 'ui-004-spike'
  timestamp: string
  userAgent: string
  wavesurferVersion: string
  fixtures: FixtureReport[]
}

// ---- helpers --------------------------------------------------------------

const now = () => performance.now()
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[i]
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}

function sigma(xs: number[]): number {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))))
}

interface PerfMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export function readMemoryMB(): number | null {
  const mem = (performance as Performance & { memory?: PerfMemory }).memory
  return mem ? mem.usedJSHeapSize / (1024 * 1024) : null
}

// ---- individual measurements ----------------------------------------------

/** Seek latency: controller.seek() until the media element fires 'seeked'. */
async function measureSeek(adapter: WaveSurferTransportAdapter, n = 16): Promise<SeekStats> {
  const duration = adapter.getDuration()
  // Cold-path sample: the first seek after load pays extra media pipeline cost.
  const cold0 = now()
  await adapter.seek(Math.min(1, duration * 0.5))
  const coldSeekMs = now() - cold0
  const xs: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t = ((i * 7919) % 1000) / 1000 // deterministic pseudo-random order
    const target = 0.5 + t * Math.max(0, duration - 1)
    const t0 = now()
    await adapter.seek(target)
    xs.push(now() - t0)
    await nextFrame()
  }
  return {
    samples: xs.length,
    medianMs: median(xs),
    p95Ms: percentile(xs, 95),
    meanMs: mean(xs),
    maxMs: Math.max(...xs),
    coldSeekMs,
  }
}

/** Playhead jitter: audio-clock vs wall-clock deltas sampled per rAF. */
async function measureJitter(
  adapter: WaveSurferTransportAdapter,
  seconds = 5,
): Promise<JitterStats> {
  const walls: number[] = []
  const audios: number[] = []
  const rate = adapter.getSnapshot().rate
  const rendersOf = () =>
    (window as unknown as { __ui004?: { getRenderCount?: () => number } }).__ui004?.getRenderCount?.() ??
    null
  await adapter.seek(Math.min(1, adapter.getDuration() * 0.1))
  await adapter.play()
  const renders0 = rendersOf()
  const deadline = now() + seconds * 1000
  while (now() < deadline) {
    await nextFrame()
    walls.push(now())
    audios.push(adapter.getCurrentTime())
  }
  adapter.pause()
  const renders1 = rendersOf()

  const errs: number[] = []
  const intervals: number[] = []
  for (let i = 1; i < walls.length; i += 1) {
    const wallDelta = walls[i] - walls[i - 1]
    const audioDeltaMs = (audios[i] - audios[i - 1]) * 1000
    if (wallDelta > 0 && wallDelta < 250) {
      errs.push(audioDeltaMs - wallDelta * rate)
      intervals.push(wallDelta)
    }
  }
  return {
    frames: walls.length,
    audioDeltaSigmaMs: sigma(errs),
    maxAbsErrMs: Math.max(0, ...errs.map(Math.abs)),
    frameIntervalMeanMs: mean(intervals),
    frameIntervalSigmaMs: sigma(intervals),
    reactRenders:
      renders0 !== null && renders1 !== null ? renders1 - renders0 : null,
  }
}

/**
 * Repeated-loop drift: arm a short loop, count wraps, compare the wall-clock
 * period to the expected audio period and measure per-wrap overshoot.
 */
async function measureLoop(adapter: WaveSurferTransportAdapter, wraps = 10): Promise<LoopStats> {
  const duration = adapter.getDuration()
  const loopLen = Math.min(1.5, duration * 0.2)
  const start = Math.max(0.5, duration * 0.25)
  const end = start + loopLen
  const rate = 1.5 // allowed rate that also keeps the measurement quick

  const wrapWall: number[] = []
  const overshoots: number[] = []
  adapter.setRate(rate)
  adapter.setLoop({ start, end })
  await adapter.seek(start + 0.01)

  return await new Promise<LoopStats>((resolve) => {
    const detach = adapter.onLoopWrap((info) => {
      wrapWall.push(now())
      overshoots.push(info.overshoot * 1000)
    })
    void adapter.play()
    const expectedPeriodMs = ((end - start) / rate) * 1000
    const timer = setInterval(() => {
      if (wrapWall.length >= wraps) {
        clearInterval(timer)
        detach()
        adapter.pause()
        adapter.setLoop(null)
        adapter.setRate(1)
        const errs = wrapWall.slice(1).map((w, i) => w - wrapWall[i] - expectedPeriodMs)
        resolve({
          wraps: wrapWall.length,
          loopStart: start,
          loopEnd: end,
          rate,
          overshootMeanMs: mean(overshoots),
          overshootMaxMs: Math.max(0, ...overshoots),
          periodErrMeanMs: mean(errs),
          periodErrMaxMs: Math.max(0, ...errs.map(Math.abs)),
          totalDriftMs: wrapWall.length > 1 ? wrapWall.at(-1)! - wrapWall[0] - expectedPeriodMs * (wrapWall.length - 1) : 0,
        })
      }
    }, 30)
  })
}

async function measureZoom(adapter: WaveSurferTransportAdapter): Promise<{ meanMs: number; maxMs: number }> {
  const ws = adapter.getWavesurfer()
  const duration = adapter.getDuration()
  const width = ws.getWidth() || 1
  const fit = duration > 0 ? width / duration : 1
  const levels = [fit, fit * 2, fit * 5, fit * 10, fit * 25, fit * 5, fit * 2, fit]
  const xs: number[] = []
  for (const px of levels) {
    const t0 = now()
    adapter.zoom(px)
    xs.push(now() - t0)
    await nextFrame()
  }
  return { meanMs: mean(xs), maxMs: Math.max(...xs) }
}

async function measurePan(adapter: WaveSurferTransportAdapter): Promise<{ meanMs: number; maxMs: number }> {
  const ws = adapter.getWavesurfer()
  const duration = adapter.getDuration()
  const width = ws.getWidth() || 1
  // Zoom in first so there is something to pan.
  adapter.zoom(Math.max(50, (width / Math.max(1, duration)) * 8))
  await nextFrame()
  const wrapper = ws.getWrapper()
  const maxScroll = Math.max(0, wrapper.scrollWidth - wrapper.clientWidth)
  const xs: number[] = []
  for (const frac of [0, 0.25, 0.5, 0.75, 1, 0.5, 0.1]) {
    const t0 = now()
    ws.setScroll(maxScroll * frac)
    xs.push(now() - t0)
    await nextFrame()
  }
  return { meanMs: mean(xs), maxMs: Math.max(...xs) }
}

async function measureRates(adapter: WaveSurferTransportAdapter): Promise<RateStat[]> {
  const duration = adapter.getDuration()
  const out: RateStat[] = []
  const media = adapter.getWavesurfer().getMediaElement()
  for (const rate of SUPPORTED_RATES) {
    adapter.setRate(rate)
    const safeEnd = Math.max(0, duration - 1)
    const startPos = Math.min(2, safeEnd)
    const budget = Math.min(2.5, (safeEnd - startPos) / rate) // wall seconds
    if (budget <= 0.3) continue
    await adapter.seek(startPos)
    await adapter.play()
    await sleep(150) // let the audio pipeline settle before timing
    const a0 = adapter.getCurrentTime()
    const w0 = now()
    await sleep(budget * 1000)
    const wallDeltaS = (now() - w0) / 1000
    const audioDeltaS = adapter.getCurrentTime() - a0
    const measured = wallDeltaS > 0 ? audioDeltaS / wallDeltaS : 0
    // Verify the preserve-pitch flag actually toggles on the media element.
    adapter.setPreservePitch(false)
    const pitchOff = media && 'preservesPitch' in media ? media.preservesPitch : null
    adapter.setPreservePitch(true)
    out.push({
      rate,
      measuredRate: measured,
      relErrorPct: Math.abs((measured - rate) / rate) * 100,
      preservesPitch: media && 'preservesPitch' in media ? media.preservesPitch : null,
      preservePitchOff: pitchOff,
    })
  }
  adapter.setRate(1)
  return out
}

function measurePeaks(adapter: WaveSurferTransportAdapter): { jsonBytes: number; maxLength: number } {
  const ws = adapter.getWavesurfer()
  const duration = adapter.getDuration()
  const maxLength = Math.min(100000, Math.max(2000, Math.ceil(duration * 10)))
  try {
    const peaks = ws.exportPeaks({ channels: 1, maxLength, precision: 10000 })
    return { jsonBytes: JSON.stringify(peaks).length, maxLength }
  } catch {
    return { jsonBytes: 0, maxLength }
  }
}

// ---- orchestration ----------------------------------------------------------

export interface RunOptions {
  adapter: WaveSurferTransportAdapter
  fixtureLabel: string
  /** Heap snapshot taken before load, if available. */
  memoryBaselineMB: number | null
  onProgress?: (stage: string) => void
  /** Shorter run for interactive use (fewer loop wraps / rate steps). */
  quick?: boolean
}

export async function runMeasurements(opts: RunOptions): Promise<FixtureReport> {
  const { adapter } = opts
  const progress = opts.onProgress ?? (() => {})
  adapter.pause()

  progress('load')
  const loadTiming = adapter.getLoadTiming() ?? { fetchDecodeMs: NaN, readyMs: NaN }
  const afterLoadMB = readMemoryMB()

  progress('seek')
  const seek = await measureSeek(adapter)

  progress('jitter')
  const jitter = await measureJitter(adapter, opts.quick ? 3 : 5)

  progress('loop')
  const loop = await measureLoop(adapter, opts.quick ? 6 : 10)

  progress('memory-playback')
  await adapter.seek(0.2)
  await adapter.play()
  await sleep(1500)
  const duringPlaybackMB = readMemoryMB()
  adapter.pause()

  progress('zoom')
  const zoom = await measureZoom(adapter)

  progress('pan')
  const pan = await measurePan(adapter)

  progress('rate')
  const rates = await measureRates(adapter)

  progress('peaks')
  const peaks = measurePeaks(adapter)

  adapter.pause()
  return {
    fixture: opts.fixtureLabel,
    durationSec: adapter.getDuration(),
    loadDecodeMs: loadTiming.fetchDecodeMs,
    loadReadyMs: loadTiming.readyMs,
    seek,
    jitter,
    loop,
    memory: {
      supported: readMemoryMB() !== null,
      beforeLoadMB: opts.memoryBaselineMB,
      afterLoadMB,
      duringPlaybackMB,
    },
    zoomMeanMs: zoom.meanMs,
    zoomMaxMs: zoom.maxMs,
    panMeanMs: pan.meanMs,
    panMaxMs: pan.maxMs,
    rates,
    peaksJsonBytes: peaks.jsonBytes,
    peaksMaxLength: peaks.maxLength,
  }
}
