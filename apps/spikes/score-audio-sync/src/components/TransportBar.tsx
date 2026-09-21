import { spikeCopy, t } from '../copy'
import { SUPPORTED_RATES, type TransportController, type TransportSnapshot } from '../transport/types'
import { TimeReadout } from './TimeReadout'

interface Props {
  snapshot: TransportSnapshot
  transport: () => TransportController | null
  onToggleLoop: () => void
  onClearRegion: () => void
  onPlaySelection: () => void
  follow: boolean
  followSuspended: boolean
  onToggleFollow: () => void
  onResumeFollow: () => void
  hasSelection: boolean
}

const SKIP_S = 5

export function TransportBar(props: Props) {
  const { snapshot } = props
  const playing = snapshot.status === 'playing'
  const ready = snapshot.status !== 'empty' && snapshot.status !== 'loading'
  const loopOn = snapshot.loop !== null

  const c = () => props.transport()

  return (
    <div className="transport-bar" role="toolbar" aria-label={t('transport.regionAria')}>
      <TimeReadout transport={props.transport} />

      <button
        type="button"
        aria-label={t('transport.toStart')}
        title={t('tooltips.toStart')}
        disabled={!ready}
        onClick={() => void c()?.seek(0)}
      >
        ⏮
      </button>
      <button
        type="button"
        className="primary"
        aria-label={playing ? t('transport.pause') : t('transport.play')}
        title={t('tooltips.playPause')}
        disabled={!ready}
        onClick={() => (playing ? c()?.pause() : void c()?.play())}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        aria-label={t('transport.stop')}
        title={t('tooltips.stop')}
        disabled={!ready}
        onClick={() => c()?.stop()}
      >
        ⏹
      </button>
      <button
        type="button"
        aria-label={t('transport.skipForward')}
        title={t('tooltips.skipForward')}
        disabled={!ready}
        onClick={() => void c()?.seek((c()?.getCurrentTime() ?? 0) + SKIP_S)}
      >
        ⏩
      </button>
      <button
        type="button"
        aria-label={t('transport.toEnd')}
        title={t('tooltips.toEnd')}
        disabled={!ready}
        onClick={() => void c()?.seek(c()?.getDuration() ?? 0)}
      >
        ⏭
      </button>

      <button
        type="button"
        aria-pressed={loopOn}
        aria-label={t('transport.loop')}
        title={t('tooltips.loop')}
        className={loopOn ? 'toggled' : ''}
        disabled={!ready || (!props.hasSelection && !loopOn)}
        onClick={props.onToggleLoop}
      >
        {t('transport.loop')}
      </button>
      <button
        type="button"
        disabled={!props.hasSelection}
        title={t('transport.playSelection')}
        onClick={props.onPlaySelection}
      >
        {t('transport.playSelection')}
      </button>
      <button
        type="button"
        disabled={!props.hasSelection}
        title={spikeCopy.clearRegion}
        onClick={props.onClearRegion}
      >
        {spikeCopy.clearRegion}
      </button>

      <label className="rate">
        {t('transport.rate')}
        <select
          aria-label={t('transport.rateAria')}
          value={snapshot.rate}
          disabled={!ready}
          onChange={(e) => c()?.setRate(Number(e.target.value))}
        >
          {SUPPORTED_RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
          {!SUPPORTED_RATES.includes(snapshot.rate as (typeof SUPPORTED_RATES)[number]) && (
            <option value={snapshot.rate}>{snapshot.rate}×</option>
          )}
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={props.follow && !props.followSuspended}
          onChange={props.onToggleFollow}
          aria-label={t('transport.followFull')}
        />
        {t('transport.follow')}
      </label>
      {props.followSuspended && (
        <button type="button" className="resume-follow" onClick={props.onResumeFollow}>
          {t('transport.resumeFollow')}
        </button>
      )}
    </div>
  )
}
