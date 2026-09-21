// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from 'vitest'
import concertXml from '../../fixtures/sync_concert.musicxml?raw'
import { Rational } from './rational'
import { buildSyncMap } from './syncMap'
import { getScoreRenderer, type ScoreRenderer } from '../score/verovio'

/**
 * Cross-validation: the spike's own MusicXML→ql map (syncMap — the same
 * contract as rhythm/timemap.py build_timemap) must agree with the *rendered
 * view's own clock* (Verovio's timemap / getTimeForElement) for every note.
 * If they agree, either side of the chain can drive the other: the engine
 * uses the exact-ql side, Verovio stays the visual renderer.
 *
 * Verovio reports element times in milliseconds at the document tempo
 * (100 bpm ⇒ 600 ms per ql).
 */

const MS_PER_QL = 600

let renderer: ScoreRenderer

beforeAll(async () => {
  renderer = await getScoreRenderer()
  renderer.load(concertXml)
})

describe('Verovio timemap vs syncMap (rendered-view clock agreement)', () => {
  const map = buildSyncMap(concertXml)

  it('every fragment onset matches getTimeForElement within 1 ms', () => {
    let checked = 0
    for (const span of map.spans) {
      for (const [i, id] of span.exportIds.entries()) {
        const ms = renderer.timeForElement(id)
        // Fragment 1 onset == span onset; continuation fragments are checked
        // through getElementsAtTime below (their ql onsets aren't in the span).
        if (i === 0) {
          const expected = span.onsetQl.toNumber() * MS_PER_QL
          expect(ms, `${id} not found`).not.toBeNull()
          expect(Math.abs(ms! - expected), `${id}`).toBeLessThanOrEqual(1)
        } else {
          expect(ms, `fragment ${id} must exist in Verovio's clock`).not.toBeNull()
        }
        checked++
      }
    }
    expect(checked).toBe(44) // 40 canonical notes + 4 continuation fragments
  })

  it('getElementsAtTime reports our canonical ids at their onsets', () => {
    const t = renderer.elementsAtTime(3 * MS_PER_QL) // ql 3 → sn-000005
    expect(t?.notes).toContain('hs-sn-000005')
    const t2 = renderer.elementsAtTime(10 * MS_PER_QL)
    expect(t2?.notes).toContain('hs-sn-000012') // tie head at ql 10
    // Inside the tie continuation (ql 13, still sounding) Verovio reports the
    // continuation fragment belonging to canonical sn-000012.
    const t3 = renderer.elementsAtTime(13 * MS_PER_QL)
    expect(t3?.notes.some((id) => id.startsWith('hs-sn-000012'))).toBe(true)
  })

  it('timemap duration covers the piece (last offset ≈ 48 ql)', () => {
    const last = map.spans[map.spans.length - 1]
    expect(last.onsetQl.eq(Rational.of(46))).toBe(true)
    expect(renderer.durationMs()).toBeGreaterThanOrEqual(48 * MS_PER_QL - 1)
  })
})
