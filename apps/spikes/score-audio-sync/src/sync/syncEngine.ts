/**
 * ScoreSyncEngine — the headless heart of UI-005.
 *
 * Owns the canonical chain for one loaded (score, warp) pair:
 *
 *   audio seconds ──warp.secondsToQl──▶ ql ──syncMap──▶ canonical ids
 *   canonical id  ──onsetQl──▶ ql ──warp.qlToSeconds──▶ audio seconds
 *
 * Everything here is DOM-free and deterministic: React components and the
 * measurement harness call the same methods, and the unit tests exercise
 * this class without any renderer (no Verovio, no wavesurfer).
 *
 * Span semantics: a canonical note is "active" on the half-open interval
 * [onsetQl, offsetQl) — the same half-open convention as the transport loop.
 */
import { Rational } from './rational'
import type { CanonicalSpan, MeasureSpan, SyncMap } from './syncMap'
import type { TimeWarp } from './timewarp'

export interface TimeRangeSec {
  start: number
  end: number
}

export class ScoreSyncEngine {
  private readonly byCanonical = new Map<string, CanonicalSpan>()
  /** Spans sorted by onset for binary search. */
  private readonly spans: CanonicalSpan[]

  constructor(
    readonly map: SyncMap,
    readonly warp: TimeWarp,
  ) {
    this.spans = [...map.spans].sort((a, b) => a.onsetQl.cmp(b.onsetQl))
    for (const s of this.spans) this.byCanonical.set(s.canonicalId, s)
  }

  /** All canonical ids known to the map. */
  canonicalIds(): string[] {
    return [...this.byCanonical.keys()]
  }

  span(canonicalId: string): CanonicalSpan | null {
    return this.byCanonical.get(canonicalId) ?? null
  }

  // ---- seconds -> score ---------------------------------------------------

  /** Exact score position for an audio-clock time. */
  qlAtSeconds(timeSec: number): Rational {
    return this.warp.secondsToQl(timeSec)
  }

  /** Canonical notes sounding at `timeSec` ([onset, offset) semantics). */
  activeAtSeconds(timeSec: number): Set<string> {
    return this.activeAtQl(this.qlAtSeconds(timeSec))
  }

  activeAtQl(q: Rational): Set<string> {
    const out = new Set<string>()
    for (const s of this.spans) {
      if (s.onsetQl.gt(q)) break // spans sorted by onset
      if (s.onsetQl.le(q) && s.offsetQl.gt(q)) out.add(s.canonicalId)
    }
    return out
  }

  /**
   * Nearest meaningful canonical element for an arbitrary audio time
   * (waveform click): a note sounding at `t` wins; otherwise the span whose
   * onset or offset boundary is closest. Returns null only for empty maps.
   */
  nearestCanonicalAtSeconds(timeSec: number): CanonicalSpan | null {
    const q = this.qlAtSeconds(timeSec)
    const active = this.activeAtQl(q)
    if (active.size > 0) {
      // Multiple actives only occur with overlaps (chords/voices); pick the
      // earliest onset for determinism.
      let best: CanonicalSpan | null = null
      for (const s of this.spans) {
        if (active.has(s.canonicalId)) {
          best = s
          break
        }
      }
      return best
    }
    let best: CanonicalSpan | null = null
    let bestDist: Rational | null = null
    for (const s of this.spans) {
      const d = q.lt(s.onsetQl) ? s.onsetQl.sub(q) : q.sub(s.offsetQl)
      if (bestDist === null || d.lt(bestDist)) {
        bestDist = d
        best = s
      }
    }
    return best
  }

  // ---- score -> seconds ---------------------------------------------------

  /** Audio-clock onset of a canonical note (score click -> seek target). */
  secondsForCanonical(canonicalId: string): number | null {
    const s = this.byCanonical.get(canonicalId)
    return s ? this.warp.qlToSeconds(s.onsetQl) : null
  }

  /** Audio-clock [start,end) span of a canonical note (sounding span). */
  secondsRangeForCanonical(canonicalId: string): TimeRangeSec | null {
    const s = this.byCanonical.get(canonicalId)
    if (!s) return null
    return {
      start: this.warp.qlToSeconds(s.onsetQl),
      end: this.warp.qlToSeconds(s.offsetQl),
    }
  }

  // ---- loop <-> score passage ----------------------------------------------

  /**
   * Canonical notes whose sounding span intersects a half-open audio range
   * [start,end) — the score-side view of an armed A-B loop.
   */
  canonicalsInRange(range: TimeRangeSec): Set<string> {
    return this.canonicalIdsInRange(
      this.warp.secondsToQl(range.start),
      this.warp.secondsToQl(range.end),
    )
  }

  /**
   * Same overlap test on exact ql bounds — preferable when the caller already
   * holds score-domain positions, because seconds→ql conversion can land an
   * interval hairline-inside a neighbouring span (documented in tests).
   */
  canonicalIdsInRange(startQl: Rational, endQl: Rational): Set<string> {
    const out = new Set<string>()
    for (const s of this.spans) {
      // overlap of [s.onset, s.offset) with [startQl, endQl)
      if (s.offsetQl.gt(startQl) && s.onsetQl.lt(endQl)) out.add(s.canonicalId)
      if (s.onsetQl.ge(endQl)) break
    }
    return out
  }

  /** Measure numbers intersecting an audio range (for the loop label). */
  measuresInRange(range: TimeRangeSec): MeasureSpan[] {
    return this.measuresInQlRange(
      this.warp.secondsToQl(range.start),
      this.warp.secondsToQl(range.end),
    )
  }

  /** Exact-ql variant of {@link measuresInRange}. */
  measuresInQlRange(startQl: Rational, endQl: Rational): MeasureSpan[] {
    return this.map.measures.filter(
      (m) => m.endQl.gt(startQl) && m.startQl.lt(endQl),
    )
  }

  /** Measure containing an audio time (current-measure readout). */
  measureAtSeconds(timeSec: number): MeasureSpan | null {
    const q = this.qlAtSeconds(timeSec)
    for (const m of this.map.measures) {
      if (m.startQl.le(q) && m.endQl.gt(q)) return m
    }
    return null
  }

  /** End of the notated score in audio seconds (transport clamp context). */
  scoreEndSeconds(): number {
    return this.warp.qlToSeconds(this.map.durationQl)
  }
}

/** Set equality helper for highlight-diff bookkeeping. */
export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
