/**
 * #156: written-score-time -> sounding-time warp for swing playback.
 *
 * Verovio's renderToTimemap ignores <sound><swing> (verified against
 * 6.3: identical tstamps), so the audition + cursor-follow would
 * otherwise play straight eighths against a score marked Swing.
 *
 * The canonical payload carries swingFeel (detected offbeat phase,
 * a fraction of one notated beat) plus the tempo map and meter map,
 * which is enough to rebuild the written-beat -> written-ms map and
 * shift each beat's second half: written phase 1/2 sounds at phase p.
 * Beat onsets, measure boundaries and the total duration are fixed
 * points — only offbeat content moves.
 */
import { parseFraction } from "./rhythmEdits";

/** Maps a written score millisecond to its sounding millisecond. */
export type ScoreTimeWarp = (writtenMs: number) => number;

interface Boundary {
  readonly beat: number;
  readonly msPerBeat: number;
}

function num(raw: unknown): number | null {
  const f = parseFraction(raw);
  if (f) return f.num / f.den;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** beat -> msPerBeat breakpoints from the tempo map + head meter.
 *
 * Canonical beats are defined by the FIRST time signature only
 * (score.py beat_ql_of), so meter changes never rescale the axis —
 * only tempo segments create breakpoints. tempo_map bpm counts
 * *primary* beats (6/8 -> dotted quarter; #157), and the exported
 * sound tempo is quarters/min = bpm * primary_ql, so one payload
 * beat lasts 60000 * beatCount / (bpm * beatsPerMeasure) ms. */
function beatBoundaries(content: Record<string, unknown>): Boundary[] | null {
  const tempo = content["tempoMap"];
  if (!Array.isArray(tempo) || tempo.length === 0) return null;
  const tempoSegs: { beat: number; bpm: number }[] = [];
  for (const raw of tempo) {
    const o = raw as Record<string, unknown>;
    const beat = num(o["startBeat"]);
    const bpm = typeof o["bpm"] === "number" ? o["bpm"] : Number(o["bpm"]);
    if (beat == null || !Number.isFinite(bpm) || bpm <= 0) return null;
    tempoSegs.push({ beat, bpm });
  }
  tempoSegs.sort((a, b) => a.beat - b.beat);
  if (tempoSegs[0].beat !== 0) {
    tempoSegs.unshift({ beat: 0, bpm: tempoSegs[0].bpm });
  }

  const head = content["timeSignature"] as Record<string, unknown> | undefined;
  const beatsPerMeasure = num(head?.["beatsPerMeasure"]);
  if (beatsPerMeasure == null || beatsPerMeasure <= 0) return null;
  // Compound meters (6/8, 9/8, 12/8) beat on dotted quarters — mirrors
  // MeterSegment.beat_count / domain primary_beat_beats.
  const beatCount =
    beatsPerMeasure % 3 === 0 && beatsPerMeasure > 3
      ? beatsPerMeasure / 3
      : beatsPerMeasure;
  return tempoSegs.map((seg) => ({
    beat: seg.beat,
    msPerBeat: (60000 * beatCount) / (seg.bpm * beatsPerMeasure),
  }));
}

/** written beat -> written ms through the boundary map (linear inside
 *  each constant-rate interval, last slope extends past the end). */
function makeBeatToMs(bounds: readonly Boundary[]): (beat: number) => number {
  const msAt = (i: number) => {
    let ms = 0;
    for (let k = 0; k < i; k += 1) {
      ms += (bounds[k + 1].beat - bounds[k].beat) * bounds[k].msPerBeat;
    }
    return ms;
  };
  return (beat: number) => {
    if (beat <= bounds[0].beat) return 0;
    for (let i = 0; i < bounds.length; i += 1) {
      const next = bounds[i + 1];
      if (!next || beat <= next.beat) {
        return msAt(i) + (beat - bounds[i].beat) * bounds[i].msPerBeat;
      }
    }
    return msAt(bounds.length - 1);
  };
}

/** written ms -> written beat (inverse of makeBeatToMs). */
function makeMsToBeat(bounds: readonly Boundary[]): (ms: number) => number {
  const msAt = (i: number) => {
    let ms = 0;
    for (let k = 0; k < i; k += 1) {
      ms += (bounds[k + 1].beat - bounds[k].beat) * bounds[k].msPerBeat;
    }
    return ms;
  };
  return (ms: number) => {
    if (ms <= 0) return 0;
    for (let i = 0; i < bounds.length; i += 1) {
      const next = bounds[i + 1];
      const end = next ? msAt(i + 1) : Number.POSITIVE_INFINITY;
      if (ms < end || !next) {
        return bounds[i].beat + (ms - msAt(i)) / bounds[i].msPerBeat;
      }
    }
    return bounds[bounds.length - 1].beat;
  };
}

/** Build the swing warp for a canonical scoreDocument dict, or null
 *  when it carries no usable swing feel (straight playback). */
export function buildSwingWarp(canonicalDocument: unknown): ScoreTimeWarp | null {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"] as Record<string, unknown> | undefined;
  if (!content) return null;
  const feel = parseFraction(content["swingFeel"]);
  if (!feel) return null;
  const p = feel.num / feel.den;
  if (!(p > 0 && p < 1)) return null;
  const bounds = beatBoundaries(content);
  if (!bounds || bounds.length === 0) return null;
  const beatToMs = makeBeatToMs(bounds);
  const msToBeat = makeMsToBeat(bounds);
  return (writtenMs: number) => {
    const beat = msToBeat(writtenMs);
    const phase = beat - Math.floor(beat);
    /* written 1/2 -> sounding p; the two halves scale linearly so
     * beat onsets and measure ends stay put. */
    const swung =
      phase <= 0.5 ? phase * 2 * p : p + (phase - 0.5) * 2 * (1 - p);
    return beatToMs(Math.floor(beat) + swung);
  };
}

/** beat -> written ms for a canonical scoreDocument dict, or null when
 *  the tempo map / head meter is missing. Shared by the swing warp and
 *  the waveform note overlay (#402). */
export function buildBeatToMs(
  canonicalDocument: unknown,
): ((beat: number) => number) | null {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"] as Record<string, unknown> | undefined;
  if (!content) return null;
  const bounds = beatBoundaries(content);
  if (!bounds || bounds.length === 0) return null;
  return makeBeatToMs(bounds);
}
