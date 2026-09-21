import type { WaveSurferTransportAdapter } from '../transport/wavesurferAdapter'
import type { ScoreSyncEngine, TimeRangeSec } from '../sync/syncEngine'
import type { PitchView } from '../fixtures'

/**
 * In-page measurement harness for UI-005. All numbers are measured with
 * performance.now() against the media element clock — no "feels smooth".
 * Driven from the UI (計測パネル) or scripts/measure.mjs (puppeteer-core).
 *
 * The harness never reaches into React internals: the app exposes a narrow
 * {@link SyncHooks} surface whose DOM-touching functions are the same code
 * paths real clicks use.
 */
export interface SyncHooks {
  adapter: WaveSurferTransportAdapter
  engine: ScoreSyncEngine
  /** Score-click path: export/canonical id -> onset -> transport.seek (awaits 'seeked'). */
  clickCanonical(canonicalId: string): Promise<void>
  /** Waveform-click path: audio seconds -> nearest canonical -> DOM mark. */
  selectAtSeconds(timeSec: number): void
  /** Currently marked hs-active canonical ids (DOM truth). */
  domActiveCanonicals(): Set<string>
  /** Currently marked hs-loop canonical ids (DOM truth). */
  domLoopCanonicals(): Set<string>
  /** Canonical id of the current selection, or null. */
  selectedCanonical(): string | null
  /** Programmatic view switch; resolves after re-render + marks reapplied. */
  switchView(view: PitchView): Promise<void>
  /** App component render counter (React-render discipline check). */
  getRenderCount(): number
  /** Verovio renderToSVG call counter (no-per-frame-render check). */
  getVerovioRenderCalls(): number
  /** Wall ms spent inside the follow scroll handler (drained per run). */
  drainFollowScrollMs(): number[]
  /** Wall ms spent inside the DOM highlight applier (drained per run). */
  drainHighlightMs(): number[]
}

export interface LatencyStats {
  samples: number
  medianMs: number
  p95Ms: number
  meanMs: number
  maxMs: number
}

export interface SyncErrorStats {
  /** rAF frames sampled during playback. */
  frames: number
  /** Frames where DOM hs-active set != expected canonical set. */
  mismatchFrames: number
  /** Active-note boundaries crossed during the window. */
  boundaries: number
  /** |audio clock at DOM update − boundary time| per transition. */
  lagMeanMs: number
  lagMaxMs: number
  /** React renders during the same window. */
  reactRenders: number
  /** Verovio renderToSVG calls during the same window (must be 0). */
  verovioRenderCalls: number
}

export interface LoopDriftStats {
  wraps: number
  loopStart: number
  loopEnd: number
  rate: number
  overshootMeanMs: number
  overshootMaxMs: number
  periodErrMeanMs: number
  periodErrMaxMs: number
  totalDriftMs: number
}

export interface LoopScoreStats {
  rangeSec: { start: number; end: number }
  expected: string[]
  domMarked: string[]
  correct: boolean
  measures: number[]
}

export interface ViewSwitchStats {
  from: PitchView
  to: PitchView
  switchMs: number
  selectionPreserved: boolean
  /** |audio clock after switch − expected continuity| — should be ~0 paused,
   *  ≈ elapsed wall while playing (clock must never reset). */
  timeConsistencyMs: number
  playingContinued: boolean
  loopPreserved: boolean
}

export interface SyncReport {
  fixture: string
  warpMode: string
  durationSec: number
  canonicalNotes: number
  scoreClickSeek: LatencyStats
  waveClickSelect: LatencyStats & { correctSelections: number }
  sync: SyncErrorStats
  follow: { calls: number; meanMs: number; maxMs: number }
  highlight: { calls: number; meanMs: number; maxMs: number }
  loopDrift: LoopDriftStats
  loopScore: LoopScoreStats
  viewSwitch: ViewSwitchStats
}

export interface FullReport {
  tool: 'ui-005-spike'
  timestamp: string
  userAgent: string
  fixtures: SyncReport[]
}

// ---- helpers ---------------------------------------------------------------

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

function latency(xs: number[]): LatencyStats {
  return {
    samples: xs.length,
    medianMs: median(xs),
    p95Ms: percentile(xs, 95),
    meanMs: mean(xs),
    maxMs: Math.max(0, ...xs),
  }
}

const sortedSet = (s: ReadonlySet<string>) => [...s].sort()

// ---- measurements -----------------------------------------------------------

/** Score click -> audio seek: canonical id -> onset seconds -> seek(). */
async function measureScoreClickSeek(hooks: SyncHooks): Promise<LatencyStats> {
  const ids = hooks.engine.canonicalIds()
  const xs: number[] = []
  for (const id of ids) {
    const t0 = now()
    await hooks.clickCanonical(id)
    xs.push(now() - t0)
    await nextFrame()
  }
  return latency(xs)
}

/**
 * Waveform click -> score context: audio time -> nearest canonical -> DOM
 * mark. Also verifies the selected canonical equals the engine's nearest.
 */
async function measureWaveClickSelect(
  hooks: SyncHooks,
): Promise<LatencyStats & { correctSelections: number }> {
  const duration = hooks.adapter.getDuration()
  const xs: number[] = []
  let correct = 0
  for (let i = 0; i < 24; i += 1) {
    const u = ((i * 7919) % 1000) / 1000
    const t = 0.3 + u * Math.max(0, duration - 0.6)
    const expected = hooks.engine.nearestCanonicalAtSeconds(t)?.canonicalId ?? null
    const t0 = now()
    hooks.selectAtSeconds(t)
    xs.push(now() - t0)
    if (expected !== null && hooks.selectedCanonical() === expected) correct += 1
    await nextFrame()
  }
  return { ...latency(xs), correctSelections: correct }
}

/**
 * Playback sync error: sample the audio clock each rAF, compute the expected
 * active canonical set, and compare with the DOM hs-active set. Transition
 * lag = audio-clock delta between an expected boundary crossing and the
 * frame where the DOM set matches it.
 */
async function measureSyncError(
  hooks: SyncHooks,
  seconds = 6,
): Promise<SyncErrorStats> {
  const { adapter, engine } = hooks
  adapter.pause()
  await adapter.seek(0.05)
  const renders0 = hooks.getRenderCount()
  const renderCalls0 = hooks.getVerovioRenderCalls()

  interface Sample {
    audioT: number
    expected: Set<string>
    dom: Set<string>
  }
  const samples: Sample[] = []
  await adapter.play()
  const deadline = now() + seconds * 1000
  while (now() < deadline) {
    await nextFrame()
    const audioT = adapter.getCurrentTime()
    samples.push({
      audioT,
      expected: engine.activeAtSeconds(audioT),
      dom: hooks.domActiveCanonicals(),
    })
  }
  adapter.pause()
  const renders1 = hooks.getRenderCount()
  const renderCalls1 = hooks.getVerovioRenderCalls()

  let mismatchFrames = 0
  const lags: number[] = []
  let prevExpected: Set<string> | null = null
  let pendingBoundary: { audioT: number; expected: Set<string> } | null = null
  for (const s of samples) {
    if (prevExpected !== null && !setEq(s.expected, prevExpected)) {
      // expected set changed at this audio time — a note boundary
      pendingBoundary = { audioT: s.audioT, expected: s.expected }
    }
    if (pendingBoundary && setEq(s.dom, pendingBoundary.expected)) {
      lags.push((s.audioT - pendingBoundary.audioT) * 1000)
      pendingBoundary = null
    }
    if (!setEq(s.dom, s.expected)) mismatchFrames += 1
    prevExpected = s.expected
  }
  // frames counted while a transition was in flight are expected lag, not errors;
  // honest accounting: report both raw mismatch count and transition count.
  return {
    frames: samples.length,
    mismatchFrames,
    boundaries: lags.length,
    lagMeanMs: mean(lags),
    lagMaxMs: Math.max(0, ...lags),
    reactRenders: renders1 - renders0,
    verovioRenderCalls: renderCalls1 - renderCalls0,
  }
}

function setEq(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** Loop wrap drift — same method as UI-004 (wrap overshoot + period error). */
async function measureLoopDrift(
  hooks: SyncHooks,
  wraps = 8,
): Promise<LoopDriftStats> {
  const { adapter } = hooks
  const duration = adapter.getDuration()
  const loopLen = Math.min(1.5, duration * 0.2)
  const start = Math.max(0.5, duration * 0.25)
  const end = start + loopLen
  const rate = 1.5

  const wrapWall: number[] = []
  const overshoots: number[] = []
  adapter.setRate(rate)
  adapter.setLoop({ start, end })
  await adapter.seek(start + 0.01)

  return await new Promise<LoopDriftStats>((resolve) => {
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
          totalDriftMs:
            wrapWall.length > 1
              ? wrapWall.at(-1)! - wrapWall[0] - expectedPeriodMs * (wrapWall.length - 1)
              : 0,
        })
      }
    }, 30)
  })
}

/**
 * Loop -> score passage: arm a known range, then compare the DOM hs-loop
 * marks with the engine's overlap set (exact set equality).
 */
async function measureLoopScore(hooks: SyncHooks): Promise<LoopScoreStats> {
  const { adapter, engine } = hooks
  const duration = adapter.getDuration()
  // A range that crosses measure boundaries and the sn-000012 tie:
  // onset of sn-000010 (m.3) through the offset of sn-000019 (m.5) — resolved
  // through the warp so it exercises the non-linear map too.
  const range: TimeRangeSec = {
    start: engine.secondsRangeForCanonical('sn-000010')?.start ?? duration * 0.25,
    end: engine.secondsRangeForCanonical('sn-000019')?.end ?? duration * 0.5,
  }
  adapter.setLoop(range)
  await nextFrame()
  await nextFrame()
  const expected = engine.canonicalsInRange(range)
  const domMarked = hooks.domLoopCanonicals()
  const measures = engine.measuresInRange(range).map((m) => m.number)
  adapter.setLoop(null)
  return {
    rangeSec: range,
    expected: sortedSet(expected),
    domMarked: sortedSet(domMarked),
    correct: setEq(expected, domMarked),
    measures,
  }
}

/** Concert↔Horn while playing: selection, transport, loop must be preserved. */
async function measureViewSwitch(hooks: SyncHooks): Promise<ViewSwitchStats> {
  const { adapter } = hooks
  // Arm a loop so its preservation is part of the check.
  const loopRange: TimeRangeSec = {
    start: adapter.getDuration() * 0.2,
    end: adapter.getDuration() * 0.4,
  }
  adapter.setLoop(loopRange)
  // Select a tied note — the interesting multi-fragment case.
  hooks.selectAtSeconds(
    hooks.engine.secondsForCanonical('sn-000012') ?? adapter.getDuration() * 0.3,
  )
  await adapter.seek(adapter.getDuration() * 0.3)
  await adapter.play()
  await sleep(400)
  const t0 = now()
  const audioBefore = adapter.getCurrentTime()
  await hooks.switchView('horn')
  const switchMs = now() - t0
  const audioAfter = adapter.getCurrentTime()
  const expectedAudio = audioBefore + switchMs / 1000
  const snap = adapter.getSnapshot()
  const stats: ViewSwitchStats = {
    from: 'concert',
    to: 'horn',
    switchMs,
    selectionPreserved: hooks.selectedCanonical() === 'sn-000012',
    timeConsistencyMs: Math.abs(audioAfter - expectedAudio) * 1000,
    playingContinued: snap.status === 'playing',
    loopPreserved:
      snap.loop !== null &&
      Math.abs(snap.loop.start - loopRange.start) < 0.01 &&
      Math.abs(snap.loop.end - loopRange.end) < 0.01,
  }
  // settle, switch back, stop loop
  await sleep(300)
  await hooks.switchView('concert')
  adapter.pause()
  adapter.setLoop(null)
  return stats
}

// ---- orchestration ----------------------------------------------------------

export interface RunOptions {
  hooks: SyncHooks
  fixtureLabel: string
  warpMode: string
  onProgress?: (stage: string) => void
}

export async function runMeasurements(opts: RunOptions): Promise<SyncReport> {
  const { hooks } = opts
  const progress = opts.onProgress ?? (() => {})
  const { adapter, engine } = hooks
  adapter.pause()

  progress('楽譜クリック→シーク')
  const scoreClickSeek = await measureScoreClickSeek(hooks)

  progress('波形クリック→ハイライト')
  const waveClickSelect = await measureWaveClickSelect(hooks)

  progress('追従＋同期誤差')
  hooks.drainFollowScrollMs()
  hooks.drainHighlightMs()
  const sync = await measureSyncError(hooks, 6)
  const followSamples = hooks.drainFollowScrollMs()
  const hlSamples = hooks.drainHighlightMs()

  progress('ループ')
  const loopDrift = await measureLoopDrift(hooks)
  const loopScore = await measureLoopScore(hooks)

  progress('表示切替')
  const viewSwitch = await measureViewSwitch(hooks)

  adapter.pause()
  return {
    fixture: opts.fixtureLabel,
    warpMode: opts.warpMode,
    durationSec: adapter.getDuration(),
    canonicalNotes: engine.canonicalIds().length,
    scoreClickSeek,
    waveClickSelect,
    sync,
    follow: {
      calls: followSamples.length,
      meanMs: mean(followSamples),
      maxMs: Math.max(0, ...followSamples),
    },
    highlight: {
      calls: hlSamples.length,
      meanMs: mean(hlSamples),
      maxMs: Math.max(0, ...hlSamples),
    },
    loopDrift,
    loopScore,
    viewSwitch,
  }
}
