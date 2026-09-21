// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import concertXml from '../../fixtures/sync_concert.musicxml?raw'
import { Rational } from './rational'
import { ScoreSyncEngine, sameSet } from './syncEngine'
import { buildSyncMap } from './syncMap'
import { TimeWarp } from './timewarp'

const map = buildSyncMap(concertXml)
const warp = TimeWarp.fixedBpm(100, 0) // 100 bpm → 0.6 s per ql

function engine() {
  return new ScoreSyncEngine(map, warp)
}

function ids(s: ReadonlySet<string>): string[] {
  return [...s].sort()
}

describe('ScoreSyncEngine.activeAt (ql → canonical set)', () => {
  const e = engine()

  it('activates on note onsets, not before', () => {
    expect(ids(e.activeAtQl(Rational.of(0)))).toEqual(['sn-000001'])
    expect(ids(e.activeAtQl(Rational.of(1)))).toEqual(['sn-000002'])
    expect(e.activeAtQl(Rational.of(-1)).size).toBe(0)
  })

  it('a note stays active through its duration (half-open [onset,offset))', () => {
    // sn-000002 is an eighth spanning ql 1–1.5: active at 1.4;
    // sn-000003 takes over at 1.5, sn-000004 at 2.
    expect(ids(e.activeAtQl(Rational.of(14, 10)))).toEqual(['sn-000002'])
    expect(ids(e.activeAtQl(Rational.of(19, 10)))).toEqual(['sn-000003'])
    expect(ids(e.activeAtQl(Rational.of(2)))).toEqual(['sn-000004'])
  })

  it('a tied note is active as ONE canonical id across all fragments', () => {
    // sn-000012 spans 10–14 (fragments in m3 and m4).
    expect(ids(e.activeAtQl(Rational.of(10)))).toEqual(['sn-000012'])
    expect(ids(e.activeAtQl(Rational.of(13)))).toEqual(['sn-000012']) // fragment 2
    // sn-000038 spans 42–45.5 across m11/m12 (3 fragments).
    expect(ids(e.activeAtQl(Rational.of(451, 10)))).toEqual(['sn-000038'])
  })

  it('returns empty in true gaps (rests, unwritten space, piece end)', () => {
    expect(e.activeAtQl(Rational.of(15)).size).toBe(0) // m4 half rest
    expect(e.activeAtQl(Rational.of(63, 2)).size).toBe(0) // m8 eighth rest
    expect(e.activeAtQl(Rational.of(48)).size).toBe(0) // end of piece
  })
})

describe('ScoreSyncEngine.nearestCanonicalAtSeconds (waveform-click context)', () => {
  const e = engine()

  it('returns the sounding note when inside one', () => {
    expect(e.nearestCanonicalAtSeconds(0.3)?.canonicalId).toBe('sn-000001') // ql 0.5
    expect(e.nearestCanonicalAtSeconds(13 * 0.6)?.canonicalId).toBe('sn-000012')
  })

  it('resolves rest gaps to the boundary-nearest note', () => {
    // rest 14–16 between sn-000012 (offset 14) and sn-000014 (onset 16):
    // midpoint ql 15 → tie → earlier span wins (deterministic scan order).
    expect(e.nearestCanonicalAtSeconds(15 * 0.6)?.canonicalId).toBe('sn-000012')
    expect(e.nearestCanonicalAtSeconds(15.4 * 0.6)?.canonicalId).toBe('sn-000014')
    // m8 rest 31–32: ql 31.5 → tie → earlier span sn-000027.
    expect(e.nearestCanonicalAtSeconds(31.5 * 0.6)?.canonicalId).toBe('sn-000027')
  })
})

describe('ScoreSyncEngine.loop → score context', () => {
  const e = engine()

  it('canonicalsInRange uses half-open overlap [start,end)', () => {
    // loop over m3 (ql 8–12): sn-000010(8–9), sn-000011(9–10),
    // sn-000012(10–14), sn-000013(11.5–12.5) all overlap;
    // sn-000009 (6–8) only touches → excluded.
    // NOTE: bounds sit exactly on ql 8/12 *by construction* here — use
    // qlDomainInRange to avoid seconds→ql double noise (see next test).
    const got = e.canonicalIdsInRange(Rational.of(8), Rational.of(12))
    expect(ids(got)).toEqual(['sn-000010', 'sn-000011', 'sn-000012', 'sn-000013'])
  })

  it('canonicalsInRange (seconds) carries float noise at exact boundaries', () => {
    // 8*0.6 as a double maps to ql 7.9999999999999997 — just below the
    // boundary — so the touch-only neighbour sn-000009 legitimately overlaps.
    // This documents the seconds-domain edge; interior bounds are stable.
    const boundary = e.canonicalsInRange({ start: 8 * 0.6, end: 12 * 0.6 })
    expect(boundary.has('sn-000009')).toBe(true) // float noise, documented
    const interior = e.canonicalsInRange({ start: 8.4 * 0.6, end: 11.9 * 0.6 })
    expect(ids(interior)).toEqual([
      'sn-000010',
      'sn-000011',
      'sn-000012',
      'sn-000013',
    ])
  })

  it('measuresInRange covers measures overlapped by the loop', () => {
    const nums = e
      .measuresInRange({ start: 10 * 0.6, end: 13 * 0.6 })
      .map((m) => m.number)
    expect(nums).toEqual([3, 4]) // 10–13 overlaps m3 (8–12) and m4 (12–16)
    // Exact ql-domain bounds: loop [8,12) touches m2 (ends at 8) and m4
    // (starts at 12) without overlapping → only m3.
    expect(
      e.measuresInQlRange(Rational.of(8), Rational.of(12)).map((m) => m.number),
    ).toEqual([3])
  })
})

describe('ScoreSyncEngine seconds bridge', () => {
  const e = engine()

  it('secondsForCanonical = qlToSeconds(onset) — score-click seek target', () => {
    expect(e.secondsForCanonical('sn-000005')).toBeCloseTo(3 * 0.6, 10)
    expect(e.secondsForCanonical('sn-000040')).toBeCloseTo(46 * 0.6, 10)
    expect(e.secondsForCanonical('nope')).toBeNull()
  })

  it('secondsRangeForCanonical spans the full tied duration', () => {
    const r = e.secondsRangeForCanonical('sn-000012')!
    expect(r.start).toBeCloseTo(10 * 0.6, 10)
    expect(r.end).toBeCloseTo(14 * 0.6, 10)
  })

  it('measureAtSeconds + scoreEndSeconds', () => {
    expect(e.measureAtSeconds(15 * 0.6)?.number).toBe(4) // inside m4 rest
    expect(e.scoreEndSeconds()).toBeCloseTo(48 * 0.6, 10)
  })

  it('sameSet drives cheap highlight diffs', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false)
  })
})
