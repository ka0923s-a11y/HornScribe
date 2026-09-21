/**
 * TypeScript mirror of the Python engine's time-warp contract
 * (`python/hornscribe/rhythm/timewarp.py` + `beatmap.py`,
 * QUANTIZER_DESIGN.md §5.2/§6). This is the seconds ↔ quarterLength (ql)
 * boundary of the canonical sync chain:
 *
 *   audio seconds  ↔  TimeWarp  ↔  score position (ql)  ↔  canonical note ids
 *
 * Ported semantics (kept identical to the Python contract):
 *  - `fixedBpm(bpm, zeroSec)`: linear map `ql = (t - zeroSec) * bpm / 60`.
 *  - `fromAnchors(anchors)`: piecewise-linear warp through beat anchors —
 *    passes exactly through every anchor, stays monotonic, never overshoots.
 *  - Out-of-range inputs extrapolate with the nearest segment slope.
 *  - Positions are exact {@link Rational} values; seconds are floats.
 *  - `qlToSeconds` requires an exact position input (Rational), mirroring the
 *    Python rule that floats are rejected there.
 *
 * BeatMap validation is mirrored: >= 2 anchors, times strictly increasing,
 * score positions strictly increasing (InvalidBeatMapError -> Error here).
 */
import { Rational } from './rational'

export interface BeatAnchor {
  /** Physical performance time in seconds (float, raw-evidence domain). */
  timeSec: number
  /** Exact score position in quarterLength units. */
  scorePosQl: Rational
}

export type TimeWarpMode = 'fixed_bpm' | 'beat_map'

export class TimeWarp {
  private constructor(
    readonly mode: TimeWarpMode,
    private readonly qlPerSec: Rational | null,
    private readonly zeroSec: Rational | null,
    private readonly times: readonly Rational[],
    private readonly positions: readonly Rational[],
    /** Float mirror of `times` for the fast segment search. */
    private readonly timesFloat: readonly number[],
  ) {}

  /** Linear warp `ql = (timeSec - zeroSec) * bpm / 60` (design 6.2). */
  static fixedBpm(bpm: number, zeroSec = 0): TimeWarp {
    if (!Number.isFinite(bpm) || bpm <= 0) {
      throw new Error(`bpm must be a positive finite number, got ${bpm}`)
    }
    if (!Number.isFinite(zeroSec)) {
      throw new Error(`zeroSec must be finite, got ${zeroSec}`)
    }
    return new TimeWarp(
      'fixed_bpm',
      Rational.fromFloat(bpm).div(Rational.of(60)),
      Rational.fromFloat(zeroSec),
      [],
      [],
      [],
    )
  }

  /**
   * Piecewise-linear warp through `anchors` (design 6.1). Between anchors
   * `(t0,q0)` and `(t1,q1)`: `W(t) = q0 + (t - t0)/(t1 - t0) * (q1 - q0)`,
   * computed in exact rational arithmetic after `Fraction(float)`-equivalent
   * conversion, so the warp passes through every anchor exactly.
   */
  static fromAnchors(anchors: readonly BeatAnchor[]): TimeWarp {
    const sorted = [...anchors].sort((a, b) => a.timeSec - b.timeSec)
    if (sorted.length < 2) {
      throw new Error(`beat map needs at least 2 anchors, got ${sorted.length}`)
    }
    for (const a of sorted) {
      if (!Number.isFinite(a.timeSec)) {
        throw new Error(`anchor timeSec must be finite, got ${a.timeSec}`)
      }
    }
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      if (cur.timeSec <= prev.timeSec) {
        throw new Error(
          `anchor times must strictly increase: ${prev.timeSec} !< ${cur.timeSec}`,
        )
      }
      if (cur.scorePosQl.le(prev.scorePosQl)) {
        throw new Error(
          `beat map must be monotonic: scorePosQl did not increase ` +
            `(${prev.scorePosQl} -> ${cur.scorePosQl} at ${cur.timeSec}s)`,
        )
      }
    }
    return new TimeWarp(
      'beat_map',
      null,
      null,
      sorted.map((a) => Rational.fromFloat(a.timeSec)),
      sorted.map((a) => a.scorePosQl),
      sorted.map((a) => a.timeSec),
    )
  }

  /** Tempo for fixed_bpm warps, else null. */
  get bpm(): number | null {
    return this.qlPerSec === null ? null : this.qlPerSec.mul(Rational.of(60)).toNumber()
  }

  /** Score-origin offset for fixed_bpm warps, else null. */
  get zeroSecValue(): number | null {
    return this.zeroSec === null ? null : this.zeroSec.toNumber()
  }

  /** Map a time in seconds to an exact quarterLength position. */
  secondsToQl(timeSec: number): Rational {
    if (!Number.isFinite(timeSec)) {
      throw new Error(`timeSec must be finite, got ${timeSec}`)
    }
    const t = Rational.fromFloat(timeSec)
    if (this.mode === 'fixed_bpm') {
      return t.sub(this.zeroSec!).mul(this.qlPerSec!)
    }
    const i = segmentIndex(this.times, this.timesFloat, t, timeSec)
    const t0 = this.times[i]
    const t1 = this.times[i + 1]
    const q0 = this.positions[i]
    const q1 = this.positions[i + 1]
    return q0.add(t.sub(t0).mul(q1.sub(q0)).div(t1.sub(t0)))
  }

  /** Convenience float view of {@link secondsToQl}. */
  secondsToQlNumber(timeSec: number): number {
    return this.secondsToQl(timeSec).toNumber()
  }

  /**
   * Inverse map: exact quarterLength position -> seconds (design 6.1).
   * The input must be a {@link Rational} — floats are rejected so drifted
   * positions cannot be mapped silently (same rule as the Python side).
   */
  qlToSeconds(posQl: Rational): number {
    if (!(posQl instanceof Rational)) {
      throw new Error('posQl must be an exact Rational')
    }
    if (this.mode === 'fixed_bpm') {
      return this.zeroSec!.add(posQl.div(this.qlPerSec!)).toNumber()
    }
    const i = segmentIndex(this.positions, null, posQl, posQl.toNumber())
    const q0 = this.positions[i]
    const q1 = this.positions[i + 1]
    const t0 = this.times[i]
    const t1 = this.times[i + 1]
    return t0.add(posQl.sub(q0).mul(t1.sub(t0)).div(q1.sub(q0))).toNumber()
  }
}

/**
 * Index `i` of the segment `[points[i], points[i+1]]` containing `x`.
 * Out-of-range `x` clamps to the first/last segment — the nearest-segment-
 * slope extrapolation rule (Python `_segment_index`, bisect_right - 1).
 * `pointsFloat` is an optional float mirror used to locate the search start
 * (exact Rational comparison then decides the boundary).
 */
function segmentIndex(
  points: readonly Rational[],
  pointsFloat: readonly number[] | null,
  x: Rational,
  xFloat: number,
): number {
  // bisect_right(points, x) on the float mirror, then exact verification.
  let i: number
  if (pointsFloat) {
    i = bisectRightFloat(pointsFloat, xFloat) - 1
  } else {
    i = bisectRightRational(points, x) - 1
  }
  if (i < 0) return 0
  return Math.min(i, points.length - 2)
}

function bisectRightFloat(xs: readonly number[], v: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v < xs[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

function bisectRightRational(xs: readonly Rational[], v: Rational): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v.lt(xs[mid])) hi = mid
    else lo = mid + 1
  }
  return lo
}
