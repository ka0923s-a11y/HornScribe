import { useEffect, useRef } from 'react'
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.js'
import { t } from '../copy'
import { WaveSurferTransportAdapter } from '../transport/wavesurferAdapter'
import { formatClock } from './TimeReadout'

interface Props {
  /** Called once the adapter exists (and again if it is rebuilt). */
  onAdapter: (adapter: WaveSurferTransportAdapter) => void
  /** User-initiated seek on the waveform (click). Seconds on the audio clock. */
  onWaveformSeek: (timeSec: number) => void
  /** User panned/dragged the waveform while follow+play were active. */
  onUserPanDuringPlayback: () => void
}

/**
 * View layer: mounts wavesurfer inside a WaveSurferTransportAdapter and
 * attaches view-only plugins (Hover, Timeline). Transport policy lives in
 * the adapter/core — this component never stores playhead time.
 */
export function WaveformView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    if (!containerRef.current) return
    const adapter = new WaveSurferTransportAdapter({
      container: containerRef.current,
      height: 104,
    })

    const ws = adapter.getWavesurfer()
    ws.registerPlugin(
      HoverPlugin.create({
        lineColor: '#3b73d9',
        labelBackground: '#20242c',
        labelColor: '#e8e8ea',
        labelSize: '11px',
        formatTimeCallback: (s) => formatClock(s),
      }),
    )
    if (timelineRef.current) {
      ws.registerPlugin(
        TimelinePlugin.create({
          container: timelineRef.current,
          formatTimeCallback: (s) => formatClock(s).slice(0, 5),
          style: { color: '#5f6672', fontSize: '10px' },
        }),
      )
    }

    const offWheel = adapter.attachWheelZoom()

    // Waveform click → audio seek is wavesurfer's own interaction; surface it
    // so the app can resolve the nearest canonical element (sync chain).
    const offInteraction = ws.on('interaction', (newTime: number) => {
      propsRef.current.onWaveformSeek(newTime)
    })

    // User *pan* (wheel/drag-scroll) while follow is active → suspend follow.
    // Deliberately NOT pointerdown: a click-to-seek must not suspend follow —
    // the score should jump to the new position and keep tracking.
    const wrapper = ws.getWrapper()
    const onUserNav = () => {
      if (adapter.core.isPlaying()) propsRef.current.onUserPanDuringPlayback()
    }
    wrapper.addEventListener('wheel', onUserNav, { passive: true })

    propsRef.current.onAdapter(adapter)
    return () => {
      offWheel()
      offInteraction()
      wrapper.removeEventListener('wheel', onUserNav)
      adapter.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="waveform-area">
      <div
        ref={containerRef}
        className="waveform"
        role="region"
        aria-label={t('waveform.regionAria')}
      />
      <div ref={timelineRef} className="timeline" aria-hidden="true" />
    </div>
  )
}
