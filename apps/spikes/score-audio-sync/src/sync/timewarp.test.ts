import { describe, expect, it } from 'vitest'
import { Rational } from './rational'
import { TimeWarp } from './timewarp'

/**
 * Mirrors of the Python contract (rhythm/timewarp.py): fixed_bpm linear map,
 * piecewise-linear beat-map warp, nearest-segment extrapolation, validation.
 */

describe('Rational', () => {
  it('normalizes and compares exactly', () => {
    expect(Rational.of(2, 4).eq(Rational.of(1, 2))).toBe(true)
    expect(Rational.of(1, 3).add(Rational.of(1, 6)).eq(Rational.of(1, 2))).toBe(true)
    expect(Rational.of(1, 10).add(Rational.of(2, 10)).toString()).toBe('3/10')
  })

  it('fromFloat is exact (Fraction(float) equivalent)', () => {
    // 0.1 is not exact in binary; the Rational must hold the true double value.
    const r = Rational.fromFloat(0.1)
    expect(r.toNumber()).toBe(0.1)
    // 0.1 + 0.2 in rationals must exceed the double 0.3 (classic check).
    const sum = Rational.fromFloat(0.1).add(Rational.fromFloat(0.2))
    expect(sum.eq(Rational.fromFloat(0.3))).toBe(false)
    expect(sum.gt(Rational.fromFloat(0.3))).toBe(true)
  })

  it('rejects non-finite values', () => {
    expect(() => Rational.fromFloat(NaN)).toThrow()
    expect(() => Rational.fromFloat(Infinity)).toThrow()
    expect(() => Rational.of(1, 0)).toThrow()
  })
})

describe('TimeWarp.fixedBpm', () => {
  it('maps seconds to ql linearly (design 6.2)', () => {
    const w = TimeWarp.fixedBpm(120, 0) // 2 ql per second
    expect(w.secondsToQl(1).eq(Rational.of(2))).toBe(true)
    expect(w.secondsToQl(0.5).eq(Rational.of(1))).toBe(true)
    expect(w.qlToSeconds(Rational.of(4))).toBe(2)
  })

  it('honours zero_sec offset', () => {
    const w = TimeWarp.fixedBpm(100, 0.4)
    // ql = (t - 0.4) * 100/60 ; t=0.4 -> 0 exactly (same double).
    expect(w.secondsToQl(0.4).eq(Rational.of(0))).toBe(true)
    // t=1.0 -> (1.0-0.4) is the double 0.59999999999999998; the result is the
    // exact Fraction(double) product — compare as float like the Python side.
    expect(w.secondsToQl(1.0).toNumber()).toBeCloseTo(1.0, 12)
    expect(w.qlToSeconds(Rational.of(1))).toBeCloseTo(1.0, 10)
    expect(w.qlToSeconds(Rational.of(0))).toBeCloseTo(0.4, 10)
  })

  it('validates inputs like the Python factory', () => {
    expect(() => TimeWarp.fixedBpm(0)).toThrow()
    expect(() => TimeWarp.fixedBpm(-120)).toThrow()
    expect(() => TimeWarp.fixedBpm(120, NaN)).toThrow()
  })
})

describe('TimeWarp.fromAnchors', () => {
  const anchors = [
    { timeSec: 0.4, scorePosQl: Rational.of(0) },
    { timeSec: 2.4, scorePosQl: Rational.of(4) }, // 2 ql/s
    { timeSec: 6.4, scorePosQl: Rational.of(8) }, // 1 ql/s — ritardando
  ]

  it('passes exactly through every anchor', () => {
    const w = TimeWarp.fromAnchors(anchors)
    for (const a of anchors) {
      expect(w.secondsToQl(a.timeSec).eq(a.scorePosQl)).toBe(true)
      expect(w.qlToSeconds(a.scorePosQl)).toBeCloseTo(a.timeSec, 10)
    }
  })

  it('interpolates piecewise-linearly between anchors', () => {
    const w = TimeWarp.fromAnchors(anchors)
    // midpoint of segment 1: t=1.4 -> ql ≈ 2 (exact up to double repr of t)
    expect(w.secondsToQl(1.4).toNumber()).toBeCloseTo(2, 12)
    // midpoint of segment 2: t=4.4 -> ql ≈ 6
    expect(w.secondsToQl(4.4).toNumber()).toBeCloseTo(6, 12)
    expect(w.qlToSeconds(Rational.of(6))).toBeCloseTo(4.4, 10)
  })

  it('extrapolates with the nearest segment slope', () => {
    const w = TimeWarp.fromAnchors(anchors)
    // before first anchor: slope 2 ql/s -> t=0 -> ql ≈ -0.8
    expect(w.secondsToQl(0).toNumber()).toBeCloseTo(-0.8, 12)
    // after last anchor: slope 1 ql/s -> t=8.4 -> ql ≈ 10
    expect(w.secondsToQl(8.4).toNumber()).toBeCloseTo(10, 12)
    expect(w.qlToSeconds(Rational.of(10))).toBeCloseTo(8.4, 10)
  })

  it('rejects invalid beat maps (mirrors InvalidBeatMapError)', () => {
    expect(() => TimeWarp.fromAnchors([])).toThrow()
    expect(() => TimeWarp.fromAnchors([anchors[0]])).toThrow()
    expect(() =>
      TimeWarp.fromAnchors([
        { timeSec: 1, scorePosQl: Rational.of(0) },
        { timeSec: 1, scorePosQl: Rational.of(4) }, // duplicate time
      ]),
    ).toThrow(/strictly increase/)
    expect(() =>
      TimeWarp.fromAnchors([
        { timeSec: 0, scorePosQl: Rational.of(0) },
        { timeSec: 1, scorePosQl: Rational.of(4) },
        { timeSec: 2, scorePosQl: Rational.of(4) }, // non-monotonic position
      ]),
    ).toThrow(/monotonic/)
    expect(() =>
      TimeWarp.fromAnchors([
        { timeSec: NaN, scorePosQl: Rational.of(0) },
        { timeSec: 1, scorePosQl: Rational.of(4) },
      ]),
    ).toThrow()
  })

  it('sorts anchors by time (input order does not matter)', () => {
    const w = TimeWarp.fromAnchors([anchors[2], anchors[0], anchors[1]])
    expect(w.secondsToQl(2.4).eq(Rational.of(4))).toBe(true)
  })

  it('rejects a float position in qlToSeconds (Python contract)', () => {
    const w = TimeWarp.fromAnchors(anchors)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => w.qlToSeconds(4 as any)).toThrow()
  })
})
