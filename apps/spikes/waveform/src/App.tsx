import { useCallback, useEffect, useRef, useState } from 'react'
import { encodeWavPcm16Mono } from './audio/wav'
import { FIXTURE_SAMPLE_RATE, synthFixture } from './audio/synth'
import { MeasurePanel } from './components/MeasurePanel'
import { TransportBar } from './components/TransportBar'
import { WaveformView } from './components/WaveformView'
import { spikeCopy, t } from './copy'
import { readMemoryMB, runMeasurements, type FixtureReport } from './measure/harness'
import type { WaveSurferTransportAdapter } from './transport/wavesurferAdapter'
import type { TransportSnapshot } from './transport/types'

const EMPTY_SNAPSHOT: TransportSnapshot = {
  status: 'empty',
  time: 0,
  duration: 0,
  rate: 1,
  preservePitch: true,
  loop: null,
  revision: 0,
}

interface FixtureDef {
  id: string
  seconds: number
  /** Static file path under public/ (present only when generated locally). */
  url: string
}

const FIXTURES: FixtureDef[] = [
  { id: '30s', seconds: 30, url: 'fixtures/sweep_30s.wav' },
  { id: '3min', seconds: 180, url: 'fixtures/sweep_3min.wav' },
  { id: '10min', seconds: 600, url: 'fixtures/sweep_10min.wav' },
]

/** Spike instrumentation: total App renders since module load. */
let renderCount = 0

export default function App() {
  renderCount += 1
  const adapterRef = useRef<WaveSurferTransportAdapter | null>(null)
  const memoryBaselineRef = useRef<number | null>(null)
  const [, setAdapterReady] = useState(0)
  const [snapshot, setSnapshot] = useState<TransportSnapshot>(EMPTY_SNAPSHOT)
  const [fixtureId, setFixtureId] = useState('30s')
  const [fixtureLabel, setFixtureLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const [follow, setFollow] = useState(true)
  const [followSuspended, setFollowSuspended] = useState(false)
  const [minimapOn, setMinimapOn] = useState(false)
  const [zoomPx, setZoomPx] = useState(1)
  const [report, setReport] = useState<FixtureReport | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureStage, setMeasureStage] = useState('')

  const transport = useCallback(() => adapterRef.current, [])

  const onAdapter = useCallback((adapter: WaveSurferTransportAdapter) => {
    adapterRef.current = adapter
    const offSnap = adapter.subscribe(setSnapshot)
    const offZoom = adapter.getWavesurfer().on('zoom', () => {
      setZoomPx(adapter.getZoomPxPerSec())
    })
    adapter.setSelectionListener((sel) => setHasSelection(sel !== null))
    adapter.setFollow(true)
    setAdapterReady((v) => v + 1)
    // detach with the adapter lifetime
    adapter.getWavesurfer().on('destroy', () => {
      offSnap()
      offZoom()
    })
  }, [])

  const loadFixture = useCallback(async (def: FixtureDef): Promise<string> => {
    const adapter = adapterRef.current
    if (!adapter) return ''
    setLoading(true)
    memoryBaselineRef.current = readMemoryMB()
    adapter.clearSelection()
    try {
      // Prefer a real file (same bytes the product cache would serve);
      // fall back to in-browser synthesis when the file was not generated.
      const head = await fetch(def.url, { method: 'HEAD' }).catch(() => null)
      if (head && head.ok) {
        await adapter.load({ kind: 'url', url: def.url })
        return `${def.id} (file)`
      }
      const pcm = synthFixture(def.seconds, FIXTURE_SAMPLE_RATE)
      const blob = encodeWavPcm16Mono(pcm, FIXTURE_SAMPLE_RATE)
      await adapter.load({ kind: 'blob', blob })
      return `${def.id} (synth)`
    } finally {
      setLoading(false)
    }
  }, [])

  const onLoadClick = useCallback(() => {
    const def = FIXTURES.find((f) => f.id === fixtureId)
    if (!def) return
    void loadFixture(def).then(setFixtureLabel)
  }, [fixtureId, loadFixture])

  const runMeasure = useCallback(async () => {
    const adapter = adapterRef.current
    if (!adapter || adapter.getSnapshot().status === 'empty') return
    setMeasuring(true)
    try {
      const r = await runMeasurements({
        adapter,
        fixtureLabel: fixtureLabel || fixtureId,
        memoryBaselineMB: memoryBaselineRef.current,
        onProgress: setMeasureStage,
      })
      setReport(r)
    } finally {
      setMeasuring(false)
      setMeasureStage('')
    }
  }, [fixtureId, fixtureLabel])

  const onToggleLoop = useCallback(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    if (adapter.getSnapshot().loop) adapter.setLoop(null)
    else {
      const sel = adapter.getSelection()
      if (sel) adapter.setLoop(sel)
    }
  }, [])

  const onToggleFollow = useCallback(() => {
    setFollow((prev) => {
      const next = !prev || followSuspended // resume counts as on
      adapterRef.current?.setFollow(next)
      if (next) setFollowSuspended(false)
      return next
    })
  }, [followSuspended])

  const onUserPanDuringPlayback = useCallback(() => {
    setFollowSuspended((s) => {
      if (!s && follow) adapterRef.current?.setFollow(false)
      return follow ? true : s
    })
  }, [follow])

  const onResumeFollow = useCallback(() => {
    setFollowSuspended(false)
    setFollow(true)
    adapterRef.current?.setFollow(true)
  }, [])

  const onZoom = useCallback((px: number) => {
    adapterRef.current?.zoom(px)
    setZoomPx(adapterRef.current?.getZoomPxPerSec() ?? px)
  }, [])

  // Keyboard transport (deck tooltips: Space/K/J/L, Home/End, Ctrl+L).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'))
        return
      const c = adapterRef.current
      if (!c || c.getSnapshot().status === 'empty' || c.getSnapshot().status === 'loading') return
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          if (e.shiftKey) c.stop()
          else if (c.getSnapshot().status === 'playing') c.pause()
          else void c.play()
          break
        case 'KeyK':
          if (c.getSnapshot().status === 'playing') c.pause()
          else void c.play()
          break
        case 'KeyJ':
          void c.seek(c.getCurrentTime() - 5)
          break
        case 'KeyL':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            onToggleLoop()
          } else {
            void c.seek(c.getCurrentTime() + 5)
          }
          break
        case 'Home':
          e.preventDefault()
          void c.seek(0)
          break
        case 'End':
          e.preventDefault()
          void c.seek(c.getDuration())
          break
        case 'Delete':
        case 'Backspace':
          c.clearSelection()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleLoop])

  // Puppeteer/measurement bridge.
  useEffect(() => {
    const api = {
      loadFixture: (id: string) => {
        const def = FIXTURES.find((f) => f.id === id)
        return def ? loadFixture(def) : Promise.resolve('')
      },
      runCurrent: (opts?: { quick?: boolean }) => {
        const adapter = adapterRef.current
        if (!adapter) return Promise.resolve(null)
        return runMeasurements({
          adapter,
          fixtureLabel: fixtureLabel || fixtureId,
          memoryBaselineMB: memoryBaselineRef.current,
          quick: opts?.quick,
        })
      },
      adapter: () => adapterRef.current,
      readMemoryMB,
      getRenderCount: () => renderCount,
      fixtures: FIXTURES.map((f) => f.id),
    }
    ;(window as unknown as { __ui004?: unknown }).__ui004 = api
  }, [fixtureId, fixtureLabel, loadFixture])

  return (
    <div className="app">
      <header className="app-header">
        <h1>{spikeCopy.title}</h1>
        <div className="fixture-bar">
          <label>
            {spikeCopy.fixtureLabel}
            <select value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>
              {FIXTURES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id === '30s'
                    ? spikeCopy.fixture30s
                    : f.id === '3min'
                      ? spikeCopy.fixture3min
                      : spikeCopy.fixture10min}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={onLoadClick} disabled={loading}>
            {loading ? spikeCopy.generating : spikeCopy.loadFixture}
          </button>
          {fixtureLabel && <span className="loaded-label">{fixtureLabel}</span>}
          {!fixtureLabel && <span className="hint">{spikeCopy.noFixtureLoaded}</span>}
        </div>
      </header>

      <TransportBar
        snapshot={snapshot}
        transport={transport}
        onToggleLoop={onToggleLoop}
        onClearRegion={() => adapterRef.current?.clearSelection()}
        onPlaySelection={() => void adapterRef.current?.playSelection()}
        follow={follow}
        followSuspended={followSuspended}
        onToggleFollow={onToggleFollow}
        onResumeFollow={onResumeFollow}
        minimapOn={minimapOn}
        onToggleMinimap={() => setMinimapOn((v) => !v)}
        zoomPx={zoomPx}
        onZoom={onZoom}
        hasSelection={hasSelection}
      />

      <WaveformView
        onAdapter={onAdapter}
        showMinimap={minimapOn}
        onUserPanDuringPlayback={onUserPanDuringPlayback}
      />
      <p className="hint region-hint">{spikeCopy.regionHandles}</p>
      {followSuspended && follow && (
        <p className="follow-note" role="status">
          {t('transport.followPaused')}
        </p>
      )}

      <MeasurePanel
        ready={snapshot.status !== 'empty' && snapshot.status !== 'loading'}
        running={measuring}
        stage={measureStage}
        report={report}
        onRun={runMeasure}
      />

      <footer className="app-footer">
        <span>{t('app.privacyNote')}</span>
      </footer>
    </div>
  )
}
