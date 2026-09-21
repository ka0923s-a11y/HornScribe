import { useState } from 'react'
import { spikeCopy } from '../copy'
import type { FixtureReport } from '../measure/harness'

interface Props {
  ready: boolean
  running: boolean
  stage: string
  report: FixtureReport | null
  onRun: () => void
}

const ms = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} ms`
const mb = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)} MB`

export function MeasurePanel(props: Props) {
  const [copied, setCopied] = useState(false)
  const r = props.report

  const copyJson = async () => {
    if (!r) return
    await navigator.clipboard.writeText(JSON.stringify(r, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="measure-panel" aria-label={spikeCopy.measureTitle}>
      <h2>{spikeCopy.measureTitle}</h2>
      <p className="hint">{spikeCopy.measureHint}</p>
      <div className="measure-actions">
        <button type="button" disabled={!props.ready || props.running} onClick={props.onRun}>
          {props.running ? spikeCopy.measureRunning : spikeCopy.measureRun}
        </button>
        {r && (
          <button type="button" onClick={() => void copyJson()}>
            {copied ? spikeCopy.measureCopied : spikeCopy.measureCopyJson}
          </button>
        )}
        {props.running && <span className="stage">{props.stage}</span>}
      </div>
      {r && (
        <table className="measure-table">
          <thead>
            <tr>
              <th>{spikeCopy.colMetric}</th>
              <th>{spikeCopy.colValue}</th>
              <th>{spikeCopy.colDetail}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{spikeCopy.metricLoadDecode}</td>
              <td>{ms(r.loadDecodeMs)}</td>
              <td>{`${r.fixture} · ${r.durationSec.toFixed(1)} s`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricLoadReady}</td>
              <td>{ms(r.loadReadyMs)}</td>
              <td>ready event</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricSeek}</td>
              <td>
                {ms(r.seek.medianMs)} / {ms(r.seek.p95Ms)}
              </td>
              <td>{`n=${r.seek.samples}, max ${ms(r.seek.maxMs)}, cold ${ms(r.seek.coldSeekMs)}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricJitter}</td>
              <td>
                {ms(r.jitter.audioDeltaSigmaMs)} / {ms(r.jitter.maxAbsErrMs)}
              </td>
              <td>{`rAF ${ms(r.jitter.frameIntervalMeanMs)} ±${r.jitter.frameIntervalSigmaMs.toFixed(1)} ms, n=${r.jitter.frames}, React renders=${r.jitter.reactRenders ?? '—'}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricLoopDrift}</td>
              <td>
                {ms(r.loop.periodErrMeanMs)} / {ms(r.loop.periodErrMaxMs)}
              </td>
              <td>{`${r.loop.wraps} wraps @${r.loop.rate}× [${r.loop.loopStart.toFixed(2)}–${r.loop.loopEnd.toFixed(2)} s], overshoot ${ms(r.loop.overshootMeanMs)}/${ms(r.loop.overshootMaxMs)}, total ${ms(r.loop.totalDriftMs)}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricMemory}</td>
              <td>
                {mb(r.memory.afterLoadMB)} / {mb(r.memory.duringPlaybackMB)}
              </td>
              <td>
                {r.memory.supported ? `baseline ${mb(r.memory.beforeLoadMB)}` : 'performance.memory 非対応'}
              </td>
            </tr>
            <tr>
              <td>{spikeCopy.metricZoom}</td>
              <td>
                {ms(r.zoomMeanMs)} / {ms(r.zoomMaxMs)}
              </td>
              <td>zoom() 呼び出し時間</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricPan}</td>
              <td>
                {ms(r.panMeanMs)} / {ms(r.panMaxMs)}
              </td>
              <td>setScroll() 呼び出し時間</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricRate}</td>
              <td>
                {r.rates.map((x) => `${x.rate}×: ${x.relErrorPct.toFixed(2)}%`).join('  ')}
              </td>
              <td>{`preservesPitch=${r.rates[0]?.preservesPitch ?? '—'}, off=${r.rates[0]?.preservePitchOff ?? '—'}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricPeaks}</td>
              <td>{`${(r.peaksJsonBytes / 1024).toFixed(0)} KB`}</td>
              <td>{`exportPeaks maxLength=${r.peaksMaxLength}`}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  )
}
