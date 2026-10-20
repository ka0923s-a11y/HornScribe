/**
 * #410: meter-segment extraction shared by the click grid
 * (metronome.ts) and the tempo->ms converters (swingWarp.ts).
 *
 * A tempo mark's bpm counts *primary* beats of the meter active where
 * the mark lands (#157 semantics) — compound meters beat on dotted
 * units. Consumers converting bpm to real time must therefore read the
 * SAME meter map; before this module, swingWarp.beatBoundaries used
 * the head signature for every segment and drifted inside meter-change
 * sections while metronome's measureLayouts was already segment-aware.
 */
import { parseFraction } from "./rhythmEdits";

/** One meter segment on the canonical beat axis (QNT-006). */
export interface MeterSegment {
  readonly startBeat: number;
  readonly beatsPerMeasure: number;
  readonly beatUnit: number;
  /** Metrical offset of the segment's first measure (mid-piece
   *  analogue of pickup beats — 0 when it lands on a downbeat). */
  readonly phaseBeats: number;
}

function num(raw: unknown): number | null {
  const f = parseFraction(raw);
  if (f) return f.num / f.den;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function contentOf(
  canonicalDocument: unknown,
): Record<string, unknown> | null {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"];
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** Primary beats per measure — compound meters beat on dotted units
 *  (mirrors MeterSegment.beat_count / primary_beat_beats). */
export function primaryBeatCount(beatsPerMeasure: number): number {
  return beatsPerMeasure % 3 === 0 && beatsPerMeasure > 3
    ? beatsPerMeasure / 3
    : beatsPerMeasure;
}

/** Measure length in canonical beats: beats_per_measure * (4/beatUnit)
 *  quarterLength divided by the beat-defining quarterLength. */
export function measureLengthBeats(
  beatsPerMeasure: number,
  beatUnit: number,
  beatQl: number,
): number {
  return (beatsPerMeasure * 4) / beatUnit / beatQl;
}

/** Canonical beats covered by ONE primary beat of `seg` — the tempo
 *  mark's referent (4/4: 1; 6/8 under a 4/4 head: 1.5). */
export function primaryBeatBeats(
  seg: Pick<MeterSegment, "beatsPerMeasure" | "beatUnit">,
  beatQl: number,
): number {
  return (
    measureLengthBeats(seg.beatsPerMeasure, seg.beatUnit, beatQl) /
    primaryBeatCount(seg.beatsPerMeasure)
  );
}

/**
 * The payload's meter segments from an already-extracted content dict —
 * `meterChanges` when present, else a
 * single head-meter segment (pickup becomes the first measure's
 * phase). null on a malformed head signature or segment entry.
 */
export function segmentsFromContent(
  content: Record<string, unknown>,
): MeterSegment[] | null {
  const head = content["timeSignature"] as
    | Record<string, unknown>
    | undefined;
  const headBeats = num(head?.["beatsPerMeasure"]);
  const headUnit = num(head?.["beatUnit"]);
  if (
    headBeats == null ||
    headBeats <= 0 ||
    headUnit == null ||
    headUnit <= 0
  ) {
    return null;
  }
  const pickup = num(content["pickupBeats"]) ?? 0;
  const raw = content["meterChanges"];
  if (Array.isArray(raw) && raw.length > 0) {
    const segs: MeterSegment[] = [];
    for (const entry of raw) {
      const o = entry as Record<string, unknown>;
      const startBeat = num(o["startBeat"]);
      const ts = o["timeSignature"] as Record<string, unknown> | undefined;
      const bpm_ = num(ts?.["beatsPerMeasure"]);
      const bu = num(ts?.["beatUnit"]);
      const phase = num(o["measurePhaseBeats"]) ?? 0;
      if (
        startBeat == null ||
        bpm_ == null ||
        bpm_ <= 0 ||
        bu == null ||
        bu <= 0 ||
        phase < 0
      ) {
        return null;
      }
      segs.push({
        startBeat,
        beatsPerMeasure: bpm_,
        beatUnit: bu,
        phaseBeats: phase,
      });
    }
    segs.sort((a, b) => a.startBeat - b.startBeat);
    return segs;
  }
  // Legacy single-meter path: pickup must fit inside a head measure;
  // a non-zero pickup becomes the first measure's phase (anacrusis).
  if (pickup < 0 || pickup >= headBeats) return null;
  return [
    {
      startBeat: 0,
      beatsPerMeasure: headBeats,
      beatUnit: headUnit,
      phaseBeats: pickup > 0 ? headBeats - pickup : 0,
    },
  ];
}

/**
 * The payload's meter segments — `meterChanges` when present, else a
 * single head-meter segment (pickup becomes the first measure's
 * phase). null on a malformed head signature or segment entry.
 */
export function meterSegments(
  canonicalDocument: unknown,
): MeterSegment[] | null {
  const content = contentOf(canonicalDocument);
  if (!content) return null;
  return segmentsFromContent(content);
}

/** The meter active at `beat` — the last segment whose startBeat is
 *  at or before the position (segments[0] covers negative beats). */
export function meterAtBeat(
  segments: readonly MeterSegment[],
  beat: number,
): MeterSegment {
  let active = segments[0];
  for (const seg of segments) {
    if (seg.startBeat > beat) break;
    active = seg;
  }
  return active;
}
