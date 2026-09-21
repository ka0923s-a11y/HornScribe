import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { getScoreRenderer, type RenderedPage, type ScoreRenderer } from './lib/verovio';
import {
  buildElementIndex,
  markCanonical,
  markCanonicalSet,
  ACTIVE_CLASS,
  SELECTED_CLASS,
  type ElementIndex,
} from './lib/domScore';
import { canonicalNoteIdFromMusicxml } from './lib/ids';
import { parseScoreDoc, describeNote, pitchLabel, type ScoreDoc } from './lib/scoreDoc';
import { metrics, formatMs } from './lib/perf';
import { copy, spikeCopy } from './copy';
import { fixtureXml, supportsHorn, type FixtureSetId, type PitchView } from './fixtures';
import { ScoreView } from './components/ScoreView';
import { NoteList } from './components/NoteList';

type RenderReason = 'initial' | 'fixture' | 'switch' | 'zoom' | 'retry' | 'inject';

interface Selection {
  exportId: string;
  canonicalId: string | null;
  onsetMs: number | null;
  page: number;
}

export default function App() {
  const rendererRef = useRef<ScoreRenderer | null>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<ElementIndex | null>(null);
  const didInit = useRef(false);

  const [fixtureSet, setFixtureSet] = useState<FixtureSetId>('golden');
  const [view, setView] = useState<PitchView>('concert');
  const [zoom, setZoom] = useState(100);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [scoreDoc, setScoreDoc] = useState<ScoreDoc | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [timeMs, setTimeMs] = useState(0);
  const [activeExportIds, setActiveExportIds] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [, bump] = useReducer((x: number) => x + 1, 0);

  // Refs mirrored so the post-render layout effect always sees fresh values.
  const selectionRef = useRef<Selection | null>(null);
  const activeCanonicalsRef = useRef<Set<string>>(new Set());

  const renderScore = useCallback(
    (reason: RenderReason, opts: { set?: FixtureSetId; v?: PitchView; z?: number; broken?: boolean } = {}) => {
      const r = rendererRef.current;
      if (!r) return;
      const setId = opts.set ?? fixtureSet;
      const v = opts.v ?? view;
      const z = opts.z ?? zoom;
      const tAll = performance.now();
      try {
        r.setZoom(z);
        const xml = opts.broken ? 'corrupt payload: this is not MusicXML' : fixtureXml(setId, v);
        const ok = metrics.measure('loadData', () => r.load(xml));
        // loadData returns 1/0 — and truncated-but-parseable XML returns 1 with
        // an empty score, so the load is only valid if notes actually exist.
        const doc = ok ? parseScoreDoc(xml) : null;
        if (!ok || !doc || doc.notes.length === 0) throw new Error('score load produced no content');
        const rendered = metrics.measure('renderPages', () => r.renderAllPages());
        setPages(rendered);
        setScoreDoc(doc);
        setDurationMs(r.durationMs());
        setRenderError(false);
        if (reason === 'switch') metrics.record('switch', performance.now() - tAll);
        if (reason === 'zoom') metrics.record('zoomRerender', performance.now() - tAll);
      } catch (e) {
        console.error('[UI-003] score render failed:', e);
        setPages([]);
        setRenderError(true);
      }
      bump();
    },
    [fixtureSet, view, zoom],
  );

  // Highlight helpers — pure DOM class toggles, no re-render (measured).
  const applyActiveDom = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current;
    if (!idx) return;
    const t = performance.now();
    markCanonicalSet(idx, canonicals, ACTIVE_CLASS);
    metrics.record('highlightDom', performance.now() - t);
  }, []);

  const applyTime = useCallback(
    (ms: number) => {
      const r = rendererRef.current;
      setTimeMs(ms);
      if (!r) return;
      const t0 = performance.now();
      const res = r.elementsAtTime(ms);
      metrics.record('elementsAtTime', performance.now() - t0);
      const ids = res?.notes ?? [];
      setActiveExportIds(ids);
      const canonicals = new Set(
        ids.map((id) => canonicalNoteIdFromMusicxml(id)).filter((x): x is string => x !== null),
      );
      activeCanonicalsRef.current = canonicals;
      applyActiveDom(canonicals);
      bump();
    },
    [applyActiveDom],
  );

  const selectExportId = useCallback(
    (exportId: string) => {
      const r = rendererRef.current;
      const canonicalId = canonicalNoteIdFromMusicxml(exportId);
      // element → time + page (verovio APIs take the export id directly)
      const t0 = performance.now();
      const onset = r?.timeForElement(exportId) ?? null;
      metrics.record('timeForElement', performance.now() - t0);
      const page = r?.pageWithElement(exportId) ?? 0;
      const sel: Selection = { exportId, canonicalId, onsetMs: onset, page };
      selectionRef.current = sel;
      setSelection(sel);
      // DOM-only highlight of *all* rendered fragments of the canonical note
      const idx = indexRef.current;
      if (idx) {
        const t = performance.now();
        markCanonical(idx, canonicalId, SELECTED_CLASS);
        if (!canonicalId) {
          const el = idx.byExportId.get(exportId);
          el?.classList.add(SELECTED_CLASS);
        }
        metrics.record('highlightDom', performance.now() - t);
      }
      if (onset !== null) applyTime(onset);
      bump();
    },
    [applyTime],
  );

  // Init once.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    let cancelled = false;
    const t0 = performance.now();
    getScoreRenderer()
      .then((r) => {
        if (cancelled) return;
        rendererRef.current = r;
        metrics.record('wasmInit', performance.now() - t0);
        setVersion(r.version);
        renderScore('initial');
      })
      .catch((e: unknown) => setInitError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After each (re)render of the SVG: rebuild the element index and reapply
  // selection/active highlights — this is also the path that proves canonical
  // selection survives renderer reload and Concert↔Horn switches.
  useLayoutEffect(() => {
    const container = scoreRef.current;
    if (!container || pages.length === 0) return;
    indexRef.current = buildElementIndex(container);
    const sel = selectionRef.current;
    if (sel?.canonicalId) {
      markCanonical(indexRef.current, sel.canonicalId, SELECTED_CLASS);
      const first = indexRef.current.byCanonical.get(sel.canonicalId)?.[0];
      first?.scrollIntoView({ block: 'nearest' });
    } else if (sel) {
      indexRef.current.byExportId.get(sel.exportId)?.classList.add(SELECTED_CLASS);
    }
    markCanonicalSet(indexRef.current, activeCanonicalsRef.current, ACTIVE_CLASS);
    bump();
  }, [pages]);

  // Ctrl+1 / Ctrl+2 presentation shortcuts (GUI_UX_PLAN §20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.ctrlKey && e.key === '1') {
        e.preventDefault();
        switchView('concert');
      } else if (e.ctrlKey && e.key === '2') {
        e.preventDefault();
        if (supportsHorn(fixtureSet)) switchView('horn');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const switchView = useCallback(
    (v: PitchView) => {
      if (v === view) return;
      setView(v);
      renderScore('switch', { v });
    },
    [view, renderScore],
  );

  const changeFixture = useCallback(
    (setId: FixtureSetId) => {
      setFixtureSet(setId);
      const v: PitchView = supportsHorn(setId) ? view : 'concert';
      setView(v);
      selectionRef.current = null;
      setSelection(null);
      renderScore('fixture', { set: setId, v });
    },
    [view, renderScore],
  );

  const changeZoom = useCallback(
    (z: number) => {
      setZoom(z);
      renderScore('zoom', { z });
    },
    [renderScore],
  );

  const injectError = useCallback(() => renderScore('inject', { broken: true }), [renderScore]);
  const retryRender = useCallback(() => renderScore('retry'), [renderScore]);

  const selectedNote = selection
    ? scoreDoc?.notes.find((n) => n.exportId === selection.exportId) ?? null
    : null;

  const metricRows: { key: string; label: string }[] = [
    { key: 'wasmInit', label: spikeCopy.metricInit },
    { key: 'loadData', label: spikeCopy.metricLoad },
    { key: 'renderPages', label: spikeCopy.metricRender },
    { key: 'highlightDom', label: spikeCopy.metricHighlight },
    { key: 'elementsAtTime', label: spikeCopy.metricTimeQuery },
    { key: 'timeForElement', label: spikeCopy.metricElementTime },
    { key: 'switch', label: spikeCopy.metricSwitch },
    { key: 'zoomRerender', label: spikeCopy.metricZoom },
  ];

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
            value={fixtureSet}
            onChange={(e) => changeFixture(e.target.value as FixtureSetId)}
          >
            <option value="golden">{spikeCopy.fixtures.golden}</option>
            <option value="minimal">{spikeCopy.fixtures.minimal}</option>
            <option value="multisystem">{spikeCopy.fixtures.multisystem}</option>
          </select>
        </label>

        <div className="hs-segment" role="group" aria-label={spikeCopy.viewSwitchAria}>
          <button
            type="button"
            aria-pressed={view === 'concert'}
            title={copy.seg.concertPitchTooltip}
            onClick={() => switchView('concert')}
          >
            {copy.seg.concertPitch}
          </button>
          <button
            type="button"
            aria-pressed={view === 'horn'}
            title={copy.seg.hornInFTooltip}
            disabled={!supportsHorn(fixtureSet)}
            onClick={() => switchView('horn')}
          >
            {copy.seg.hornInF}
          </button>
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
            aria-label={spikeCopy.zoom}
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

        <button type="button" onClick={injectError} title={spikeCopy.injectErrorTooltip}>
          {spikeCopy.injectError}
        </button>
      </div>

      <div className="hs-timebar" role="group" aria-label={spikeCopy.timeLabel}>
        <label className="hs-field hs-time-field">
          {spikeCopy.timeLabel}
          <input
            type="range"
            min={0}
            max={Math.max(durationMs, 1)}
            step={10}
            value={timeMs}
            onChange={(e) => applyTime(Number(e.target.value))}
          />
        </label>
        <span className="hs-timecode">{(timeMs / 1000).toFixed(2)} 秒</span>
        <span className="hs-active-notes">
          {spikeCopy.activeAtTime}:{' '}
          {activeExportIds.length > 0
            ? activeExportIds
                .map((id) => `${id}→${canonicalNoteIdFromMusicxml(id) ?? '-'}`)
                .join('、')
            : spikeCopy.noActiveNotes}
        </span>
      </div>

      <main className="hs-main">
        {scoreDoc && (
          <NoteList
            heading={spikeCopy.noteListHeading}
            notes={scoreDoc.notes}
            selectedExportId={selection?.exportId ?? null}
            selectedCanonical={selection?.canonicalId ?? null}
            activeCanonicals={activeCanonicalsRef.current}
            onSelect={selectExportId}
          />
        )}

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
              <button type="button" onClick={retryRender}>
                {copy.renderFailed.actions.retry}
              </button>
            </div>
          ) : pages.length === 0 ? (
            <p className="hs-loading">{spikeCopy.loading}…</p>
          ) : (
            <ScoreView
              ref={scoreRef}
              pages={pages}
              ariaLabel={copy.a11y.scoreRegion}
              onElementClick={selectExportId}
            />
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
                    <dt>{spikeCopy.measureField}</dt>
                    <dd>{selectedNote.measure}</dd>
                  </>
                )}
                <dt>{spikeCopy.onsetMs}</dt>
                <dd>{selection.onsetMs !== null ? `${selection.onsetMs} ms` : '—'}</dd>
                <dt>{spikeCopy.pagesLabel}</dt>
                <dd>{selection.page > 0 ? selection.page : '—'}</dd>
              </dl>
            )}
          </section>

          <section aria-label={spikeCopy.metricsHeading}>
            <h2 className="hs-panel-title">{spikeCopy.metricsHeading}</h2>
            <table className="hs-metrics">
              <tbody>
                {metricRows.map(({ key, label }) => {
                  const s = metrics.stats(key);
                  return (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>
                        {s ? `${formatMs(s.last)}（平均 ${formatMs(s.avg)} / 最大 ${formatMs(s.max)} / ${s.count}回）` : '—'}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <th scope="row">{spikeCopy.pagesLabel}</th>
                  <td>{pages.length || '—'}</td>
                </tr>
                <tr>
                  <th scope="row">{spikeCopy.notesLabel}</th>
                  <td>{indexRef.current?.noteCount ?? '—'}</td>
                </tr>
                <tr>
                  <th scope="row">{spikeCopy.dprLabel}</th>
                  <td>{window.devicePixelRatio}</td>
                </tr>
                <tr>
                  <th scope="row">{spikeCopy.versionLabel}</th>
                  <td>{version || '—'}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </aside>
      </main>
    </div>
  );
}
