/**
 * #101: 自動演奏のメトロノーム/クリック + カウントイン。
 *
 * The click layer derives the measure grid from the canonical payload —
 * the TS port of "domain/score.py::measure_spans" (QNT-006: meter
 * changes clip running measures, phased first measures, implicit
 * anacrusis). Beat positions map to the playback-table ms axis through
 * buildBeatToMs — the same tempo-map reading the swing warp uses, so
 * clicks land exactly on the (warp-invariant) beat onsets.
 *
 * Clicks fire on primary (felt) beats: compound meters (6/8, 9/8, 12/8)
 * click dotted beats, matching the tempo map's bpm semantics. A span's
 * first click is accented only when it is a true downbeat (cycle
 * position 0) — anacrusis and mid-piece phased measures start
 * off-downbeat and do not fake an accent.
 */
import { parseFraction } from "./rhythmEdits";
import { buildBeatToMs, buildMsToBeat } from "./swingWarp";

/** One measure on the canonical beat axis (mirror of MeasureSpan). */
export interface MeasureLayout {
  /** MusicXML measure number — 0 for the implicit anacrusis measure. */
  readonly number: number;
  readonly startBeat: number;
  readonly endBeat: number;
  /** Primary (felt) beats in a FULL measure of this meter. */
  readonly beatCount: number;
  /** One primary beat in canonical beats (compound: dotted unit). */
  readonly primaryBeatBeats: number;
  /** First measure of a new meter segment. */
  readonly meterChange: boolean;
  /** Implicit anacrusis measure (number 0). */
  readonly implicit: boolean;
  /** Position inside the meter's measure cycle (0 except phased firsts). */
  readonly cycleOffsetBeats: number;
}

export interface ClickEvent {
  /** Playback-table ms of the click. */
  readonly startMs: number;
  /** Downbeat (cycle position 0) vs an ordinary primary beat. */
  readonly accent: boolean;
}

export interface CountInClick {
  /** Score-ms offset from the count-in start (0..countInMs). */
  readonly offsetMs: number;
  readonly accent: boolean;
}

function num(raw: unknown): number | null {
  const f = parseFraction(raw);
  if (f) return f.num / f.den;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface MeterSegment {
  startBeat: number;
  beatsPerMeasure: number;
  beatUnit: number;
  phaseBeats: number;
}

/** Primary beats per measure — compound meters beat on dotted units
 *  (mirrors MeterSegment.beat_count / primary_beat_beats). */
function primaryBeatCount(beatsPerMeasure: number): number {
  return beatsPerMeasure % 3 === 0 && beatsPerMeasure > 3
    ? beatsPerMeasure / 3
    : beatsPerMeasure;
}

/** Measure length in canonical beats: beats_per_measure * (4/beatUnit)
 *  quarterLength divided by the beat-defining quarterLength. */
function measureLengthBeats(
  beatsPerMeasure: number,
  beatUnit: number,
  beatQl: number,
): number {
  return (beatsPerMeasure * 4) / beatUnit / beatQl;
}

function contentOf(canonicalDocument: unknown): Record<
  string,
  unknown
> | null {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"];
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

function readSegments(
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
  const mlen0 = headBeats;
  return [
    {
      startBeat: 0,
      beatsPerMeasure: headBeats,
      beatUnit: headUnit,
      phaseBeats: pickup > 0 ? mlen0 - pickup : 0,
    },
  ];
}

/** Content end in canonical beats: max note/rest end (pickup floor). */
function contentEndBeat(
  content: Record<string, unknown>,
  pickup: number,
): number {
  let end = pickup;
  const parts = content["parts"];
  if (Array.isArray(parts)) {
    for (const rawPart of parts) {
      const part = rawPart as Record<string, unknown>;
      const notes = part["notes"];
      if (Array.isArray(notes)) {
        for (const rawNote of notes) {
          const n = rawNote as Record<string, unknown>;
          const s = num(n["startBeat"]);
          const d = num(n["durationBeats"]);
          if (s != null && d != null) end = Math.max(end, s + d);
        }
      }
      const rests = part["rests"];
      if (Array.isArray(rests)) {
        for (const rawRest of rests) {
          const r = rawRest as Record<string, unknown>;
          const s = num(r["startBeat"]);
          if (s == null) continue;
          const atoms = r["atoms"];
          let dur = 0;
          if (Array.isArray(atoms)) {
            for (const rawAtom of atoms) {
              const a = num(
                (rawAtom as Record<string, unknown>)["durationBeats"],
              );
              if (a != null) dur += a;
            }
          }
          end = Math.max(end, s + dur);
        }
      }
    }
  }
  return end;
}

/** Measure layout of a canonical scoreDocument dict — the TS port of
 *  domain.score.measure_spans (QNT-006). null on a malformed payload. */
export function measureLayouts(
  canonicalDocument: unknown,
): MeasureLayout[] | null {
  const content = contentOf(canonicalDocument);
  if (!content) return null;
  const segments = readSegments(content);
  if (!segments || segments.length === 0) return null;
  const head = content["timeSignature"] as Record<string, unknown>;
  const headUnit = num(head["beatUnit"]);
  if (headUnit == null || headUnit <= 0) return null;
  const beatQl = 4 / headUnit;
  const pickup = num(content["pickupBeats"]) ?? 0;
  const end = contentEndBeat(content, pickup);

  const spans: MeasureLayout[] = [];
  let number = 1;
  for (let i = 0; i < segments.length; i += 1) {
    const change = segments[i];
    const segEnd = i + 1 < segments.length ? segments[i + 1].startBeat : null;
    const mlen = measureLengthBeats(
      change.beatsPerMeasure,
      change.beatUnit,
      beatQl,
    );
    const beatCount = primaryBeatCount(change.beatsPerMeasure);
    let pos = change.startBeat;
    let first = true;
    while (first || (segEnd !== null ? pos < segEnd : pos < end)) {
      const dur = first ? mlen - change.phaseBeats : mlen;
      let mEnd = pos + dur;
      if (segEnd !== null && mEnd > segEnd) mEnd = segEnd;
      if (mEnd <= pos) break; // safety: zero-length measure
      const implicit = first && i === 0 && change.phaseBeats > 0;
      spans.push({
        number: implicit ? 0 : number,
        startBeat: pos,
        endBeat: mEnd,
        beatCount,
        primaryBeatBeats: mlen / beatCount,
        meterChange: first && i > 0,
        implicit,
        cycleOffsetBeats: first ? change.phaseBeats : 0,
      });
      if (!implicit) number += 1;
      pos = mEnd;
      first = false;
    }
  }
  return spans;
}

const EPS = 1e-9;

/**
 * The full in-score click track on the playback ms axis: one click per
 * primary beat of every measure, accented on true downbeats (cycle
 * position 0). null when the payload lacks meter/tempo maps.
 */
export function clickTrack(
  canonicalDocument: unknown,
): ClickEvent[] | null {
  const layouts = measureLayouts(canonicalDocument);
  const beatToMs = buildBeatToMs(canonicalDocument);
  if (!layouts || !beatToMs) return null;
  const clicks: ClickEvent[] = [];
  for (const span of layouts) {
    const q = span.primaryBeatBeats;
    const c = span.cycleOffsetBeats;
    const dur = span.endBeat - span.startBeat;
    const jMin = Math.ceil(c / q - EPS);
    const jMax = Math.ceil((c + dur) / q - EPS);
    for (let j = jMin; j < jMax; j += 1) {
      clicks.push({
        startMs: beatToMs(span.startBeat + j * q - c),
        accent: j === 0,
      });
    }
  }
  clicks.sort((a, b) => a.startMs - b.startMs);
  // Defensive dedupe — a boundary shared by clipped/next segments could
  // emit the same ms twice.
  return clicks.filter(
    (c, i) => i === 0 || Math.abs(c.startMs - clicks[i - 1].startMs) > 1e-6,
  );
}

/** The meter + local primary-beat duration at a play position — the
 *  shared input of countInMs / countInPattern. Falls back to the last
 *  measure's meter when the position sits past the final barline. */
function countInContext(
  canonicalDocument: unknown,
  positionMs: number,
): { beatCount: number; beatMs: number } | null {
  const layouts = measureLayouts(canonicalDocument);
  const beatToMs = buildBeatToMs(canonicalDocument);
  const msToBeat = buildMsToBeat(canonicalDocument);
  if (!layouts || layouts.length === 0 || !beatToMs || !msToBeat) {
    return null;
  }
  let span = layouts[layouts.length - 1];
  for (const s of layouts) {
    if (positionMs < beatToMs(s.endBeat)) {
      span = s;
      break;
    }
  }
  const q = span.primaryBeatBeats;
  const beatAt = msToBeat(Math.max(0, positionMs));
  let beatMs = beatToMs(beatAt + q) - beatToMs(beatAt);
  if (!(beatMs > 0)) {
    // Degenerate tempo map — fall back to the span's mean beat length.
    beatMs =
      ((beatToMs(span.endBeat) - beatToMs(span.startBeat)) * q) /
      Math.max(EPS, span.endBeat - span.startBeat);
  }
  return { beatCount: span.beatCount, beatMs };
}

/** Count-in length in score-ms: one full measure of the meter at the
 *  play position, at the local tempo (tempo-map aware). 0 when the
 *  payload has no usable meter/tempo. */
export function countInMs(
  canonicalDocument: unknown,
  positionMs: number,
): number {
  const ctx = countInContext(canonicalDocument, positionMs);
  if (!ctx) return 0;
  return ctx.beatCount * ctx.beatMs;
}

/** The count-in click pattern as score-ms offsets from the count-in
 *  start — first click accented (it is the count-in bar's "1"). The
 *  last click lands one beat before the entry, so the pattern flows
 *  straight into the in-score click at the play position. */
export function countInPattern(
  canonicalDocument: unknown,
  positionMs: number,
): CountInClick[] {
  const ctx = countInContext(canonicalDocument, positionMs);
  if (!ctx) return [];
  const out: CountInClick[] = [];
  for (let k = 0; k < ctx.beatCount; k += 1) {
    out.push({ offsetMs: k * ctx.beatMs, accent: k === 0 });
  }
  return out;
}
