import { useEffect, useRef } from 'react'
import { t } from '../copy'
import type { TransportController } from '../transport/types'

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/**
 * Playhead time readout. Updates a DOM text node via rAF reading the
 * controller's audio clock directly — deliberately NOT React state, so the
 * app never re-renders at frame rate (GUI_UX_PLAN §10 TransportState rule).
 */
export function TimeReadout({ transport }: { transport: () => TransportController | null }) {
  const ref = useRef<HTMLSpanElement>(null)
  const transportRef = useRef(transport)
  transportRef.current = transport

  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      const c = transportRef.current()
      const text = c
        ? `${formatClock(c.getCurrentTime())} / ${formatClock(c.getDuration())}`
        : '--:--.--- / --:--.---'
      if (text !== last && ref.current) {
        ref.current.textContent = text
        last = text
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <span
      ref={ref}
      className="time-readout"
      role="status"
      aria-label={t('transport.timeDisplayAria')}
    />
  )
}
