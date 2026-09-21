import { useEffect, useRef } from 'react'
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.js'
import MinimapPlugin from 'wavesurfer.js/dist/plugins/minimap.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.js'
import { t } from '../copy'
import { WaveSurferTransportAdapter } from '../transport/wavesurferAdapter'
import { formatClock } from './TimeReadout'

interface Props {
  /** Called once the adapter exists (and again if it is rebuilt). */
  onAdapter: (adapter: WaveSurferTransportAdapter) => void
  showMinimap: boolean
  /** User scrolled/dragged the waveform while follow+play were active. */
  onUserPanDuringPlayback: () => void
}

/**
 * View layer: mounts wavesurfer inside a WaveSurferTransportAdapter and
 * attaches view-only plugins (Hover, Timeline, Minimap). Transport policy
 * lives in the adapter/core — this component never stores playhead time.
 */
export function WaveformView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<WaveSurferTransportAdapter | null>(null)
  const minimapRef = useRef<MinimapPlugin | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  // Create adapter once.
  useEffect(() => {
    if (!containerRef.current) return
    const adapter = new WaveSurferTransportAdapter({
      container: containerRef.current,
      height: 112,
    })
    adapterRef.current = adapter

    const ws = adapter.getWavesurfer()
    ws.registerPlugin(
      HoverPlugin.create({
        lineColor: '#e8b339',
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
          style: { color: '#9aa3b2', fontSize: '10px' },
        }),
      )
    }

    const offWheel = adapter.attachWheelZoom()

    // User pan/drag while follow is active → let the app suspend follow.
    const wrapper = ws.getWrapper()
    const onUserNav = () => {
      if (adapter.core.isPlaying()) propsRef.current.onUserPanDuringPlayback()
    }
    wrapper.addEventListener('wheel', onUserNav, { passive: true })
    wrapper.addEventListener('pointerdown', onUserNav, { passive: true })

    propsRef.current.onAdapter(adapter)
    return () => {
      offWheel()
      wrapper.removeEventListener('wheel', onUserNav)
      wrapper.removeEventListener('pointerdown', onUserNav)
      adapter.dispose()
      adapterRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Minimap toggle.
  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    const ws = adapter.getWavesurfer()
    if (props.showMinimap && !minimapRef.current) {
      minimapRef.current = ws.registerPlugin(
        MinimapPlugin.create({ height: 28, waveColor: '#3a4a63', progressColor: '#7fb3ff' }),
      )
    } else if (!props.showMinimap && minimapRef.current) {
      minimapRef.current.destroy()
      minimapRef.current = null
    }
  }, [props.showMinimap])

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
