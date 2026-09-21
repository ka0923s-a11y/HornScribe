/**
 * Canonical sync map: MusicXML -> ordered canonical note spans in exact
 * quarterLength (ql) positions.
 *
 * This is the middle of the canonical chain (MASTER_PLAN §9):
 *
 *   audio seconds ↔ TimeWarp ↔ canonical note ids ↔ MusicXML @id ↔ rendered elements
 *
 * Positions are computed from MusicXML `<duration>`/`<divisions>` only —
 * deterministic, independent of the renderer. Verovio's timemap is used by
 * the spike app only as a cross-check (see syncMap.verovio.test.ts); the
 * product chain never routes sync through renderer internals.
 *
 * Element-level rules mirrored from the Python engine (domain/ids.py):
 *  - `hs-sn-<6 digits>(-<k>)` export ids resolve to canonical `sn-*`;
 *    consecutive <note> elements sharing one canonical id are tie fragments
 *    of the same canonical note (fragment 1 carries the onset).
 *  - `hs-rest-*` carries no canonical identity but still advances the cursor.
 *  - `<chord/>` notes share the previous onset; `<backup>`/`<forward>` move
 *    the cursor (multi-voice safety), and `<divisions>` may change per
 *    measure attributes.
 */
import { canonicalNoteIdFromMusicxml, isMusicxmlRestId } from '../score/ids'
import { Rational } from './rational'

/** One canonical note's sounding span (merged across tie fragments). */
export interface CanonicalSpan {
  /** Canonical score note id (`sn-000003`). */
  canonicalId: string
  /** Ordered MusicXML export ids of its fragments (`hs-sn-000003`, `-2`, …). */
  exportIds: string[]
  /** Exact onset position in ql. */
  onsetQl: Rational
  /** Exact offset (end of the last fragment) in ql. */
  offsetQl: Rational
  /** 1-based measure number where the first fragment starts. */
  measure: number
}

/** Measure boundaries in ql (for loop-passage indication and labels). */
export interface MeasureSpan {
  /** Measure `number` attribute (1-based in the fixtures). */
  number: number
  startQl: Rational
  endQl: Rational
}

export interface SyncMap {
  /** Canonical spans sorted by onset. */
  spans: CanonicalSpan[]
  /** Measure spans sorted by startQl. */
  measures: MeasureSpan[]
  /** Total notated length in ql (last offset / measure end). */
  durationQl: Rational
}

interface RawNote {
  exportId: string
  canonicalId: string | null
  isRest: boolean
  chord: boolean
  onsetQl: Rational
  offsetQl: Rational
  measure: number
}

/**
 * Parse a score-partwise MusicXML string into a {@link SyncMap}.
 * Single-part documents are the spike scope (same as ENG-001 fixtures).
 * Throws on unparsable XML so callers can surface the copy-deck error state.
 */
export function buildSyncMap(xml: string): SyncMap {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('MusicXML parse failed')
  }
  const spans: CanonicalSpan[] = []
  const measures: MeasureSpan[] = []
  let lastOffset = Rational.zero()

  for (const part of Array.from(doc.querySelectorAll('score-partwise > part'))) {
    let cursor = Rational.zero()
    let prev: RawNote | null = null
    /** Canonical id -> span accumulator. Fragments of one canonical note are
     *  merged by id, NOT by adjacency: a foreign note (e.g. sn-000013 between
     *  hs-sn-000012 and hs-sn-000012-2 across a barline) may sit between two
     *  fragments of the same tied note in document order. */
    const spanByCanonical = new Map<string, CanonicalSpan>()
    /** <divisions> persists until redefined (MusicXML semantics) — it must
     *  NOT reset per measure. */
    let divisions = Rational.of(1)

    for (const measure of Array.from(part.querySelectorAll(':scope > measure'))) {
      const measureStart = cursor
      const number = Number(measure.getAttribute('number') ?? measures.length + 1)
      // In MusicXML, <backup>/<forward> move the cursor inside a measure;
      // a measure's extent is the max cursor reached, not the final cursor.
      let measureEnd = cursor

      for (const el of Array.from(measure.children)) {
        const tag = el.tagName
        if (tag === 'attributes') {
          const div = el.querySelector(':scope > divisions')?.textContent
          if (div !== null && div !== undefined) {
            const d = Number(div)
            if (Number.isFinite(d) && d > 0) divisions = Rational.of(Math.round(d))
          }
        } else if (tag === 'note') {
          const durEl = el.querySelector(':scope > duration')?.textContent
          const durTicks = durEl ? Number(durEl) : 0
          const durQl = Number.isFinite(durTicks)
            ? Rational.of(Math.round(durTicks)).div(divisions)
            : Rational.zero()
          const chord = el.querySelector(':scope > chord') !== null
          const onset = chord && prev ? prev.onsetQl : cursor
          const offset = onset.add(durQl)
          const exportId = el.getAttribute('id') ?? ''
          const canonicalId = canonicalNoteIdFromMusicxml(exportId)
          const raw: RawNote = {
            exportId,
            canonicalId,
            isRest:
              el.querySelector(':scope > rest') !== null || isMusicxmlRestId(exportId),
            chord,
            onsetQl: onset,
            offsetQl: offset,
            measure: number,
          }
          if (!chord) cursor = cursor.add(durQl)
          measureEnd = measureEnd.gt(cursor) ? measureEnd : cursor
          prev = raw

          if (canonicalId !== null) {
            // Merge every fragment of the same canonical note into one span.
            const existing = spanByCanonical.get(canonicalId)
            if (existing) {
              existing.exportIds.push(exportId)
              if (offset.gt(existing.offsetQl)) existing.offsetQl = offset
              if (onset.lt(existing.onsetQl)) existing.onsetQl = onset
            } else {
              spanByCanonical.set(canonicalId, {
                canonicalId,
                exportIds: [exportId],
                onsetQl: onset,
                offsetQl: offset,
                measure: number,
              })
            }
          }
        } else if (tag === 'backup' || tag === 'forward') {
          const durEl = el.querySelector(':scope > duration')?.textContent
          const durTicks = durEl ? Number(durEl) : 0
          if (Number.isFinite(durTicks)) {
            const delta = Rational.of(Math.round(durTicks)).div(divisions)
            cursor = tag === 'backup' ? cursor.sub(delta) : cursor.add(delta)
            if (cursor.lt(Rational.zero())) cursor = Rational.zero()
            measureEnd = measureEnd.gt(cursor) ? measureEnd : cursor
          }
          prev = null
        } else {
          // direction/sound/print etc. — inert for the map.
        }
      }

      if (measureEnd.gt(measureStart)) {
        measures.push({ number, startQl: measureStart, endQl: measureEnd })
        cursor = measureEnd
      }
      lastOffset = lastOffset.gt(cursor) ? lastOffset : cursor
      prev = null
    }
    for (const s of spanByCanonical.values()) spans.push(s)
  }

  spans.sort((a, b) => a.onsetQl.cmp(b.onsetQl))
  return { spans, measures, durationQl: lastOffset }
}

/**
 * Convenience: pitch (midi) per canonical id, derived from the first
 * fragment's <pitch> — used by the audio synth so fixture tones match the
 * concert-pitch score. Returns null for non-pitched elements.
 */
export function pitchMidiByCanonical(
  xml: string,
): Map<string, { midi: number; span: CanonicalSpan }> {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const map = buildSyncMap(xml)
  const byExport = new Map<string, CanonicalSpan>()
  for (const s of map.spans) for (const id of s.exportIds) byExport.set(id, s)
  const out = new Map<string, { midi: number; span: CanonicalSpan }>()
  for (const noteEl of Array.from(doc.querySelectorAll('part > measure > note'))) {
    const exportId = noteEl.getAttribute('id') ?? ''
    const canonicalId = canonicalNoteIdFromMusicxml(exportId)
    if (!canonicalId || out.has(canonicalId)) continue
    const step = noteEl.querySelector('pitch > step')?.textContent
    const octave = Number(noteEl.querySelector('pitch > octave')?.textContent)
    const alter = Number(noteEl.querySelector('pitch > alter')?.textContent ?? 0)
    const span = byExport.get(exportId)
    if (!step || !Number.isFinite(octave) || !span) continue
    const base = STEP_SEMITONE[step]
    if (base === undefined) continue
    const midi = (octave + 1) * 12 + base + (Number.isFinite(alter) ? alter : 0)
    out.set(canonicalId, { midi, span })
  }
  return out
}

const STEP_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}
