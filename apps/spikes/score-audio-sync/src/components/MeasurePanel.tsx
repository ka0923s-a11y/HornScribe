import { useState } from 'react'
import { spikeCopy } from '../copy'
import type { SyncReport } from '../measure/harness'

interface Props {
  ready: boolean
  running: boolean
  stage: string
  report: SyncReport | null
  onRun: () => void
}

const ms = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} ms`

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
      <h2 className="hs-panel-title">{spikeCopy.measureTitle}</h2>
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
              <td>{spikeCopy.metricScoreSeek}</td>
              <td>
                {ms(r.scoreClickSeek.medianMs)} / {ms(r.scoreClickSeek.p95Ms)}
              </td>
              <td>{`n=${r.scoreClickSeek.samples}, max ${ms(r.scoreClickSeek.maxMs)}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricWaveSelect}</td>
              <td>
                {ms(r.waveClickSelect.medianMs)} / {ms(r.waveClickSelect.p95Ms)}
              </td>
              <td>{`n=${r.waveClickSelect.samples}, 正解 ${r.waveClickSelect.correctSelections}/${r.waveClickSelect.samples}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricSyncError}</td>
              <td>
                {ms(r.sync.lagMeanMs, 1)} / {ms(r.sync.lagMaxMs, 1)}
              </td>
              <td>{`${r.sync.boundaries} 遷移, ${r.sync.mismatchFrames}/${r.sync.frames} フレーム不一致`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricHighlightCost}</td>
              <td>
                {ms(r.highlight.meanMs, 2)} / {ms(r.highlight.maxMs, 2)}
              </td>
              <td>{`n=${r.highlight.calls}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricFollowCost}</td>
              <td>
                {ms(r.follow.meanMs, 2)} / {ms(r.follow.maxMs, 2)}
              </td>
              <td>{`n=${r.follow.calls}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricLoop}</td>
              <td>
                {ms(r.loopDrift.periodErrMeanMs)} / {ms(r.loopDrift.periodErrMaxMs)}
              </td>
              <td>{`${r.loopDrift.wraps} 回 @${r.loopDrift.rate}× [${r.loopDrift.loopStart.toFixed(2)}–${r.loopDrift.loopEnd.toFixed(2)} s], overshoot ${ms(r.loopDrift.overshootMeanMs)}/${ms(r.loopDrift.overshootMaxMs)}, 累計 ${ms(r.loopDrift.totalDriftMs)}`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricLoopScore}</td>
              <td>{r.loopScore.correct ? spikeCopy.correct : spikeCopy.incorrect}</td>
              <td>{`第${r.loopScore.measures[0]}–${r.loopScore.measures.at(-1)}小節, ${r.loopScore.domMarked.length} 音符`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricViewSwitch}</td>
              <td>{ms(r.viewSwitch.switchMs)}</td>
              <td>
                {`選択維持=${r.viewSwitch.selectionPreserved ? '○' : '×'} 再生継続=${r.viewSwitch.playingContinued ? '○' : '×'} ループ維持=${r.viewSwitch.loopPreserved ? '○' : '×'} 時刻誤差 ${ms(r.viewSwitch.timeConsistencyMs)}`}
              </td>
            </tr>
            <tr>
              <td>{spikeCopy.metricReact}</td>
              <td>{`${r.sync.reactRenders} 回`}</td>
              <td>{`${r.sync.frames} フレーム中（≈${(r.sync.reactRenders / (r.sync.frames / 60)).toFixed(1)} Hz）`}</td>
            </tr>
            <tr>
              <td>{spikeCopy.metricVerovioCalls}</td>
              <td>{`${r.sync.verovioRenderCalls} 回`}</td>
              <td>再生中の renderToSVG（0 が期待値）</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  )
}
