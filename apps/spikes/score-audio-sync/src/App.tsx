import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { encodeWavPcm16Mono } from './audio/wav'
import { synthScoreAudio } from './audio/synth'
import { MeasurePanel } from './components/MeasurePanel'
import { ScoreView } from './components/ScoreView'
import { TransportBar } from './components/TransportBar'
import { WaveformView } from './components/WaveformView'
import { copy, spikeCopy, t } from './copy'
import { FIXTURES, fixtureXml, type FixtureId, type PitchView } from './fixtures'
import { runMeasurements, type SyncHooks, type SyncReport } from './measure/harness'
import {
  ACTIVE_CLASS,
  LOOP_CLASS,
  MEASURE_ACTIVE_CLASS,
  SELECTED_CLASS,
  buildElementIndex,
  markCanonical,
  markCanonicalSet,
  markMeasures,
  type ElementIndex,
} from './score/domScore'
import { canonicalNoteIdFromMusicxml } from './score/ids'
import { describeNote, parseScoreDoc, pitchLabel, type ScoreDoc } from './score/scoreDoc'
import { getScoreRenderer, renderStats, type RenderedPage, type ScoreRenderer } from './score/verovio'
import { ScoreSyncEngine, sameSet } from './sync/syncEngine'
import { buildSyncMap, pitchMidiByCanonical } from './sync/syncMap'
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

interface Selection {
  exportId: string
  canonicalId: string | null
  onsetSec: number | null
  measure: number | null
}

/** Spike instrumentation counters (read by the measurement harness). */
let renderCount = 0
const followScrollMs: number[] = []
const highlightMs: number[] = []

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))

export default function App() {
  renderCount += 1
  const adapterRef = useRef<WaveSurferTransportAdapter | null>(null)
  const rendererRef = useRef<ScoreRenderer | null>(null)
  const scoreRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef<ElementIndex | null>(null)
  const engineRef = useRef<ScoreSyncEngine | null>(null)
  const didInit = useRef(false)

  const [fixtureId, setFixtureId] = useState<FixtureId>('steady')
  const [view, setView] = useState<PitchView>('concert')
  const [zoom, setZoom] = useState(100)
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [scoreDoc, setScoreDoc] = useState<ScoreDoc | null>(null)
  const [snapshot, setSnapshot] = useState<TransportSnapshot>(EMPTY_SNAPSHOT)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [activeCanonicals, setActiveCanonicals] = useState<ReadonlySet<string>>(new Set())
  const [currentMeasure, setCurrentMeasure] = useState<number | null>(null)
  const [loopMeasures, setLoopMeasures] = useState<number[]>([])
  const [hasSelection, setHasSelection] = useState(false)
  const [follow, setFollow] = useState(true)
  const [followSuspended, setFollowSuspended] = useState(false)
  const [audioReady, setAudioReady] = useState(false)
  const [scoreReady, setScoreReady] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [report, setReport] = useState<SyncReport | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureStage, setMeasureStage] = useState('')

  // Refs mirrored so the rAF pump / layout effect always see fresh values.
  const selectionRef = useRef<Selection | null>(null)
  const activeRef = useRef<ReadonlySet<string>>(new Set())
  const loopCanonicalsRef = useRef<ReadonlySet<string>>(new Set())
  const followRef = useRef(true)
  const suspendedRef = useRef(false)
  const zoomRef = useRef(100)
  const fixtureIdRef = useRef(fixtureId)
  const viewRef = useRef(view)
  followRef.current = follow
  suspendedRef.current = followSuspended
  zoomRef.current = zoom
  fixtureIdRef.current = fixtureId
  viewRef.current = view

  const transport = useCallback(() => adapterRef.current, [])

  // ---- DOM-only sync appliers (never re-render) ----------------------------

  const applyActiveDom = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current
    const container = scoreRef.current
    if (!idx || !container) return
    const t0 = performance.now()
    markCanonicalSet(idx, canonicals, ACTIVE_CLASS)
    const els: Element[] = []
    for (const id of canonicals) els.push(...(idx.byCanonical.get(id) ?? []))
    markMeasures(container, els, MEASURE_ACTIVE_CLASS, true)
    highlightMs.push(performance.now() - t0)
  }, [])

  const applyLoopDom = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current
    if (!idx) return
    markCanonicalSet(idx, canonicals, LOOP_CLASS)
  }, [])

  const scrollCanonicalIntoView = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current
    if (!idx || canonicals.size === 0) return
    // Earliest-onset active note leads the scroll target (engine order).
    const engine = engineRef.current
    let target: Element | null = null
    if (engine) {
      for (const span of engine.map.spans) {
        if (canonicals.has(span.canonicalId)) {
          target = idx.byCanonical.get(span.canonicalId)?.[0] ?? null
          break
        }
      }
    }
    target ??= idx.byCanonical.get([...canonicals][0])?.[0] ?? null
    if (!target) return
    const t0 = performance.now()
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    followScrollMs.push(performance.now() - t0)
  }, [])

  // ---- score render ---------------------------------------------------------

  const renderScore = useCallback(
    (v: PitchView, z: number, fId: FixtureId) => {
      const r = rendererRef.current
      if (!r) return
      try {
        r.setZoom(z)
        const xml = fixtureXml(fId, v)
        const ok = r.load(xml)
        const doc = ok ? parseScoreDoc(xml) : null
        if (!ok || !doc || doc.notes.length === 0) throw new Error('score load produced no content')
        setPages(r.renderAllPages())
        setScoreDoc(doc)
        setRenderError(false)
      } catch (e) {
        console.error('[UI-005] score render failed:', e)
        setPages([])
        setRenderError(true)
      }
    },
    [],
  )

  // ---- init: renderer + sync map + synthesized audio ------------------------

  const loadAudio = useCallback(async (fId: FixtureId) => {
    const adapter = adapterRef.current
    if (!adapter) return
    const fixture = FIXTURES[fId]
    const warp = fixture.buildWarp()
    // Canonical structure is identical in concert/horn (same ids+durations);
    // the map is built once from the concert document — the canonical side
    // of the chain never depends on which presentation is rendered.
    const map = buildSyncMap(fixture.concertXml)
    const engine = new ScoreSyncEngine(map, warp)
    engineRef.current = engine
    const pitches = pitchMidiByCanonical(fixture.concertXml)
    const notes = [...pitches.values()].map(({ midi, span }) => ({ midi, span }))
    const pcm = synthScoreAudio({
      notes,
      warp,
      tailSec: 0.8,
    })
    const blob = encodeWavPcm16Mono(pcm, 44100)
    setAudioReady(false)
    adapter.clearSelection()
    await adapter.load({ kind: 'blob', blob })
    setAudioReady(true)
  }, [])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    let cancelled = false
    getScoreRenderer()
      .then((r) => {
        if (cancelled) return
        rendererRef.current = r
        setVersion(r.version)
        renderScore(view, zoomRef.current, fixtureId)
        setScoreReady(true)
      })
      .catch((e: unknown) => setInitError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Audio loads once the wavesurfer adapter exists (WaveformView mount).
  const onAdapter = useCallback(
    (adapter: WaveSurferTransportAdapter) => {
      adapterRef.current = adapter
      adapter.subscribe(setSnapshot)
      adapter.setSelectionListener((sel) => setHasSelection(sel !== null))
      adapter.setFollow(true)
      void loadAudio(fixtureIdRef.current)
    },
    [loadAudio],
  )

  // ---- per-frame sync pump (DOM-only, no React state on the frame path) ------

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const adapter = adapterRef.current
      const engine = engineRef.current
      const idx = indexRef.current
      if (adapter && engine && idx && adapter.getDuration() > 0) {
        const time = adapter.getCurrentTime()
        const set = engine.activeAtSeconds(time)
        if (!sameSet(set, activeRef.current)) {
          activeRef.current = set
          applyActiveDom(set)
          setActiveCanonicals(set)
          setCurrentMeasure(engine.measureAtSeconds(time)?.number ?? null)
          if (followRef.current && !suspendedRef.current && adapter.core.isPlaying()) {
            scrollCanonicalIntoView(set)
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [applyActiveDom, scrollCanonicalIntoView])

  // After each (re)render of the SVG: rebuild the element index and reapply
  // selection/active/loop marks — also how they survive Concert↔Horn and zoom.
  useLayoutEffect(() => {
    const container = scoreRef.current
    if (!container || pages.length === 0) return
    indexRef.current = buildElementIndex(container)
    const sel = selectionRef.current
    if (sel?.canonicalId) {
      markCanonical(indexRef.current, sel.canonicalId, SELECTED_CLASS)
    } else if (sel) {
      indexRef.current.byExportId.get(sel.exportId)?.classList.add(SELECTED_CLASS)
    }
    markCanonicalSet(indexRef.current, activeRef.current, ACTIVE_CLASS)
    markCanonicalSet(indexRef.current, loopCanonicalsRef.current, LOOP_CLASS)
    // Reapply the measure wash too — it would otherwise be lost until the
    // next active-set change after a view switch / zoom re-render.
    const actEls: Element[] = []
    for (const id of activeRef.current) {
      actEls.push(...(indexRef.current.byCanonical.get(id) ?? []))
    }
    markMeasures(container, actEls, MEASURE_ACTIVE_CLASS, true)
  }, [pages])

  // ---- interactions ---------------------------------------------------------

  /** Score click: export id -> canonical -> onset ql -> seconds -> seek. */
  const selectExportId = useCallback(
    (exportId: string, opts: { seek?: boolean } = {}) => {
      const engine = engineRef.current
      const canonicalId = canonicalNoteIdFromMusicxml(exportId)
      const span = canonicalId ? engine?.span(canonicalId) : null
      const onsetSec = canonicalId ? (engine?.secondsForCanonical(canonicalId) ?? null) : null
      const sel: Selection = {
        exportId,
        canonicalId,
        onsetSec,
        measure: span?.measure ?? null,
      }
      selectionRef.current = sel
      setSelection(sel)
      const idx = indexRef.current
      if (idx) {
        markCanonical(idx, canonicalId, SELECTED_CLASS)
        if (!canonicalId) idx.byExportId.get(exportId)?.classList.add(SELECTED_CLASS)
      }
      if (opts.seek !== false && onsetSec !== null) {
        void adapterRef.current?.seek(onsetSec)
      }
    },
    [],
  )

  /** Waveform click path: audio seconds -> nearest canonical -> select+reveal. */
  const selectAtSeconds = useCallback((timeSec: number) => {
    const engine = engineRef.current
    if (!engine) return
    const span = engine.nearestCanonicalAtSeconds(timeSec)
    if (!span) return
    const sel: Selection = {
      exportId: span.exportIds[0],
      canonicalId: span.canonicalId,
      onsetSec: engine.secondsForCanonical(span.canonicalId),
      measure: span.measure,
    }
    selectionRef.current = sel
    setSelection(sel)
    const idx = indexRef.current
    if (idx) {
      markCanonical(idx, span.canonicalId, SELECTED_CLASS)
      idx.byCanonical.get(span.canonicalId)?.[0]?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }
    setCurrentMeasure(engine.measureAtSeconds(timeSec)?.number ?? span.measure)
  }, [])

  const onWaveformSeek = useCallback(
    (timeSec: number) => {
      // wavesurfer already performed the audio seek; resolve score context.
      selectAtSeconds(timeSec)
    },
    [selectAtSeconds],
  )

  const suspendFollow = useCallback(() => {
    if (!followRef.current || suspendedRef.current) return
    suspendedRef.current = true
    setFollowSuspended(true)
    adapterRef.current?.setFollow(false)
  }, [])

  const resumeFollow = useCallback(() => {
    suspendedRef.current = false
    setFollowSuspended(false)
    setFollow(true)
    followRef.current = true
    adapterRef.current?.setFollow(true)
    // Re-anchor immediately on the current active note.
    scrollCanonicalIntoView(activeRef.current)
  }, [scrollCanonicalIntoView])

  const onToggleFollow = useCallback(() => {
    if (follow && !followSuspended) {
      // turning follow off entirely
      setFollow(false)
      followRef.current = false
      adapterRef.current?.setFollow(false)
    } else {
      resumeFollow()
    }
  }, [follow, followSuspended, resumeFollow])

  /** Concert↔Horn: reload + re-render; transport/selection untouched.
   *  Compares against viewRef (not the render-time `view` state) so a stale
   *  closure — e.g. the measurement harness holding an older callback — can
   *  never skip a real switch. */
  const switchView = useCallback(
    async (v: PitchView) => {
      if (v === viewRef.current) return
      viewRef.current = v
      setView(v)
      renderScore(v, zoomRef.current, fixtureIdRef.current)
      // marks reapply in the layout effect on the new pages
      await nextFrame()
      await nextFrame()
    },
    [renderScore],
  )

  const changeFixture = useCallback(
    async (fId: FixtureId) => {
      if (fId === fixtureIdRef.current) return
      fixtureIdRef.current = fId
      setFixtureId(fId)
      selectionRef.current = null
      setSelection(null)
      loopCanonicalsRef.current = new Set()
      setLoopMeasures([])
      // MusicXML is shared across fixtures — only the warp+audio change.
      // Rebuild the engine inside loadAudio, then re-render is unnecessary.
      await loadAudio(fId)
    },
    [loadAudio],
  )

  const changeZoom = useCallback(
    (z: number) => {
      zoomRef.current = z
      setZoom(z)
      renderScore(viewRef.current, z, fixtureIdRef.current)
    },
    [renderScore],
  )

  // Loop -> score passage indication, driven by transport snapshots.
  useEffect(() => {
    const loop = snapshot.loop
    const engine = engineRef.current
    if (!engine) return
    const set = loop ? engine.canonicalsInRange(loop) : new Set<string>()
    if (!sameSet(set, loopCanonicalsRef.current)) {
      loopCanonicalsRef.current = set
      applyLoopDom(set)
      setLoopMeasures(loop ? engine.measuresInRange(loop).map((m) => m.number) : [])
    }
  }, [snapshot.loop, applyLoopDom])

  const onToggleLoop = useCallback(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    if (adapter.getSnapshot().loop) adapter.setLoop(null)
    else {
      const sel = adapter.getSelection()
      if (sel) adapter.setLoop(sel)
    }
  }, [])

  const runMeasure = useCallback(async (): Promise<SyncReport | null> => {
    const adapter = adapterRef.current
    const engine = engineRef.current
    if (!adapter || !engine || adapter.getSnapshot().status === 'empty') return null
    setMeasuring(true)
    try {
      const hooks: SyncHooks = {
        adapter,
        engine,
        clickCanonical: async (canonicalId) => {
          const sec = engine.secondsForCanonical(canonicalId)
          if (sec === null) return
          const span = engine.span(canonicalId)
          if (span) selectExportId(span.exportIds[0], { seek: false })
          await adapter.seek(sec)
        },
        selectAtSeconds,
        domActiveCanonicals: () => domCanonicalSet(ACTIVE_CLASS),
        domLoopCanonicals: () => domCanonicalSet(LOOP_CLASS),
        selectedCanonical: () => selectionRef.current?.canonicalId ?? null,
        switchView: (v) => switchView(v),
        getRenderCount: () => renderCount,
        getVerovioRenderCalls: () => renderStats.renderToSVGCalls,
        drainFollowScrollMs: () => followScrollMs.splice(0),
        drainHighlightMs: () => highlightMs.splice(0),
      }
      const r = await runMeasurements({
        hooks,
        fixtureLabel: FIXTURES[fixtureId].labelJa,
        warpMode: engine.warp.mode,
        onProgress: setMeasureStage,
      })
      setReport(r)
      return r
    } finally {
      setMeasuring(false)
      setMeasureStage('')
    }
  }, [fixtureId, selectAtSeconds, selectExportId, switchView])

  function domCanonicalSet(cls: string): Set<string> {
    const out = new Set<string>()
    const container = scoreRef.current
    if (!container) return out
    for (const el of Array.from(container.querySelectorAll(`.${cls}`))) {
      const c = canonicalNoteIdFromMusicxml(el.id)
      if (c) out.add(c)
    }
    return out
  }

  // Puppeteer/measurement bridge.
  useEffect(() => {
    const api = {
      adapter: () => adapterRef.current,
      engine: () => engineRef.current,
      ready: () =>
        adapterRef.current !== null &&
        engineRef.current !== null &&
        adapterRef.current.getSnapshot().status !== 'empty' &&
        pages.length > 0,
      runCurrent: () => runMeasure(),
      switchView,
      selectAtSeconds,
      setFixture: (id: FixtureId) => changeFixture(id),
      getRenderCount: () => renderCount,
      getVerovioRenderCalls: () => renderStats.renderToSVGCalls,
    }
    ;(window as unknown as { __ui005?: unknown }).__ui005 = api
  }, [pages.length, runMeasure, switchView, selectAtSeconds, changeFixture])

  // Keyboard transport (deck tooltips: Space/K/J/L, Home/End, Ctrl+L, Ctrl+1/2).
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
        case 'Digit1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            void switchView('concert')
          }
          break
        case 'Digit2':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            void switchView('horn')
          }
          break
        case 'Escape':
          selectionRef.current = null
          setSelection(null)
          if (indexRef.current) markCanonical(indexRef.current, null, SELECTED_CLASS)
          adapterRef.current?.clearSelection()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleLoop, switchView])

  const ready = audioReady && scoreReady && snapshot.status !== 'empty'
  const selectedNote = selection
    ? (scoreDoc?.notes.find((n) => n.exportId === selection.exportId) ?? null)
    : null

  return (
    <div className="hs-app">
      <header className="hs-header">
        <h1>{spikeCopy.title}</h1>
        <p className="hs-subtitle">{spikeCopy.subtitle}</p>
      </header>

      <div className="hs-toolbar" role="toolbar" aria-label={copy.score.toolbarAria}>
        <label className="hs-field">
          {spikeCopy.fixtureLabel}
          <select
            value={fixtureId}
            onChange={(e) => void changeFixture(e.target.value as FixtureId)}
          >
            <option value="steady">{FIXTURES.steady.labelJa}</option>
            <option value="warped">{FIXTURES.warped.labelJa}</option>
          </select>
        </label>

        <div className="hs-segment" role="group" aria-label={copy.a11y.viewSwitcher}>
          <button
            type="button"
            aria-pressed={view === 'concert'}
            title={copy.seg.concertPitchTooltip}
            onClick={() => void switchView('concert')}
          >
            {copy.seg.concertPitch}
          </button>
          <button
            type="button"
            aria-pressed={view === 'horn'}
            title={copy.seg.hornInFTooltip}
            onClick={() => void switchView('horn')}
          >
            {copy.seg.hornInF}
          </button>
          {view === 'horn' && <span className="hs-horn-caption">{copy.seg.hornCaption}</span>}
        </div>

        <div className="hs-zoom" role="group" aria-label={copy.score.zoomAria}>
          <button
            type="button"
            aria-label={spikeCopy.zoomOut}
            onClick={() => changeZoom(Math.max(25, zoom - 25))}
          >
            −
          </button>
          <input
            type="range"
            min={25}
            max={200}
            step={25}
            value={zoom}
            aria-label={spikeCopy.scoreZoom}
            onChange={(e) => changeZoom(Number(e.target.value))}
          />
          <button
            type="button"
            aria-label={spikeCopy.zoomIn}
            onClick={() => changeZoom(Math.min(200, zoom + 25))}
          >
            ＋
          </button>
          <span className="hs-zoom-value">{zoom}%</span>
        </div>
      </div>

      <TransportBar
        snapshot={snapshot}
        transport={transport}
        onToggleLoop={onToggleLoop}
        onClearRegion={() => adapterRef.current?.clearSelection()}
        onPlaySelection={() => void adapterRef.current?.playSelection()}
        follow={follow}
        followSuspended={followSuspended}
        onToggleFollow={onToggleFollow}
        onResumeFollow={resumeFollow}
        hasSelection={hasSelection}
      />

      <WaveformView
        onAdapter={onAdapter}
        onWaveformSeek={onWaveformSeek}
        onUserPanDuringPlayback={suspendFollow}
      />
      <p className="hint">{spikeCopy.waveformClickHint}</p>

      <div className="hs-statusbar" role="status">
        <span>
          {spikeCopy.currentMeasure}: {currentMeasure !== null ? `第${currentMeasure}小節` : '—'}
        </span>
        <span>
          {spikeCopy.activeNotes}:{' '}
          {activeCanonicals.size > 0 ? [...activeCanonicals].sort().join('、') : spikeCopy.noActiveNotes}
        </span>
        <span>
          {spikeCopy.loopPassage}:{' '}
          {loopMeasures.length > 0
            ? `第${loopMeasures[0]}–${loopMeasures.at(-1)}小節`
            : spikeCopy.noLoop}
        </span>
      </div>

      <main className="hs-main">
        <section className="hs-score-area">
          {initError ? (
            <div className="hs-error-panel" role="alert">
              <h2>{copy.renderFailed.title}</h2>
              <p>{initError}</p>
            </div>
          ) : renderError ? (
            <div className="hs-error-panel" role="alert">
              <h2>{copy.renderFailed.title}</h2>
              <p>{copy.renderFailed.body}</p>
              <button type="button" onClick={() => renderScore(view, zoom, fixtureId)}>
                {copy.renderFailed.actions.retry}
              </button>
            </div>
          ) : pages.length === 0 ? (
            <p className="hs-loading">{spikeCopy.loadingScore}…</p>
          ) : (
            <ScoreView
              ref={scoreRef}
              pages={pages}
              ariaLabel={copy.a11y.scoreRegion}
              onElementClick={(id) => selectExportId(id)}
              onUserNavigate={suspendFollow}
            />
          )}
          <p className="hint">{spikeCopy.scoreClickHint}</p>
          {followSuspended && (
            <p className="follow-note" role="status">
              {t('transport.followPaused')}{' '}
              <button type="button" className="resume-follow" onClick={resumeFollow}>
                {t('transport.resumeFollow')}
              </button>
            </p>
          )}
        </section>

        <aside className="hs-side">
          <section aria-label={spikeCopy.selectionHeading}>
            <h2 className="hs-panel-title">{spikeCopy.selectionHeading}</h2>
            {selection === null ? (
              <p className="hs-dim">{spikeCopy.selectionEmpty}</p>
            ) : (
              <dl className="hs-props">
                <dt>{spikeCopy.canonicalId}</dt>
                <dd>
                  <code>{selection.canonicalId ?? spikeCopy.selectionRest}</code>
                </dd>
                <dt>{spikeCopy.exportId}</dt>
                <dd>
                  <code>{selection.exportId}</code>
                </dd>
                {selectedNote && (
                  <>
                    <dt>{spikeCopy.pitchField}</dt>
                    <dd>
                      {selectedNote.isRest ? '—' : pitchLabel(selectedNote)}{' '}
                      {describeNote(selectedNote)}
                    </dd>
                  </>
                )}
                <dt>{spikeCopy.measureField}</dt>
                <dd>{selection.measure ?? '—'}</dd>
                <dt>{spikeCopy.onsetSec}</dt>
                <dd>{selection.onsetSec !== null ? `${selection.onsetSec.toFixed(3)} s` : '—'}</dd>
              </dl>
            )}
          </section>

          <MeasurePanel
            ready={ready}
            running={measuring}
            stage={measureStage}
            report={report}
            onRun={runMeasure}
          />
        </aside>
      </main>

      <footer className="hs-footer">
        <span>{t('app.privacyNote')}</span>
        <span className="hs-dim">Verovio {version}</span>
      </footer>
    </div>
  )
}
