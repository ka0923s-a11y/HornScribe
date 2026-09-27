/**
 * #402: canonical notes -> waveform overlay spans (sounding seconds).
 *
 * Canonical notes live on the beat axis (startBeat/durationBeats). The
 * waveform strip lives in source-audio seconds, so a note's on-screen
 * position must pass through the same tempo map + swing warp the
 * audition uses — straight beats under a <sound><swing> direction would
 * otherwise sit visibly ahead/behind the audio the user hears.
 */
import { parseFraction } from "./rhythmEdits";
import { buildBeatToMs, buildSwingWarp } from "./swingWarp";

/** One canonical note as a waveform strip span. */
export interface WaveformNote {
  /** Canonical note id (sn-*) — matches score selection identity. */
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly midi: number;
  /** 0-based part index — a second voice colours differently. */
  readonly partIndex: number;
  /** #427: the tracked f0 contour inside the note — (pos 0..1, semitone
   *  offset from the written pitch) points straight off canonical
   *  pitchBends. Present when the engine tracked the note; imported /
   *  hand-built notes carry none and draw a flat line. */
  readonly bends?: readonly { pos: number; semis: number }[];
}

/** #427: a note's continuous-pitch contour in strip coordinates —
 *  absolute seconds + sounding MIDI (bend offsets already folded in). */
export interface WaveformF0Contour {
  readonly id: string;
  readonly partIndex: number;
  readonly points: readonly { sec: number; midi: number }[];
}

/** Canonical payloads write beats as "n/d" strings (score.py _frac). */
function beatNum(raw: unknown): number | null {
  const f = parseFraction(raw);
  if (f) return f.num / f.den;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Every sounding note across all parts, ordered by startSec.
 *  Returns [] when the document carries no usable tempo map. */
export function waveformNoteOverlay(
  canonicalDocument: unknown,
): readonly WaveformNote[] {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"] as Record<string, unknown> | undefined;
  const parts = content?.["parts"];
  const beatToMs = buildBeatToMs(canonicalDocument);
  if (!content || !Array.isArray(parts) || !beatToMs) return [];
  const warp = buildSwingWarp(canonicalDocument);
  const toSec = (beat: number) => {
    const writtenMs = beatToMs(beat);
    return (warp ? warp(writtenMs) : writtenMs) / 1000;
  };
  const out: WaveformNote[] = [];
  for (let pi = 0; pi < parts.length; pi += 1) {
    const notes = (parts[pi] as Record<string, unknown>)["notes"];
    if (!Array.isArray(notes)) continue;
    for (const raw of notes) {
      const n = raw as Record<string, unknown>;
      if (n["deleted"] === true) continue;
      const start = beatNum(n["startBeat"]);
      const dur = beatNum(n["durationBeats"]);
      const midi = typeof n["pitchMidi"] === "number" ? n["pitchMidi"] : null;
      if (start == null || dur == null || dur <= 0 || midi == null) continue;
      const startSec = toSec(start);
      const endSec = toSec(start + dur);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
      out.push({
        id: String(n["id"] ?? ""),
        startSec,
        endSec: Math.max(endSec, startSec + 0.02),
        midi,
        partIndex: pi,
        bends: readBends(n["pitchBends"]),
      });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Canonical pitchBends -> {pos, semis} points; undefined when absent
 *  or malformed (the overlay falls back to a flat contour line). */
function readBends(
  raw: unknown,
): readonly { pos: number; semis: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pts = raw
    .map((b) => {
      const p = (b as Record<string, unknown>)["timeSec"];
      const s = (b as Record<string, unknown>)["bendSemitones"];
      return typeof p === "number" && typeof s === "number"
        ? { pos: p, semis: s }
        : null;
    })
    .filter((x): x is { pos: number; semis: number } => x !== null);
  return pts.length > 0 ? pts : undefined;
}

/**
 * #427: note spans -> continuous f0 contour polylines. Bend pos is the
 * fraction inside the note span, semis the offset from the written
 * pitch — the polyline lands exactly where the engine heard the pitch
 * move, so a wrong note boundary shows up as a contour that disagrees
 * with the drawn rectangle.
 */
export function waveformF0Contours(
  notes: readonly WaveformNote[],
): readonly WaveformF0Contour[] {
  const out: WaveformF0Contour[] = [];
  for (const n of notes) {
    const span = n.endSec - n.startSec;
    if (!(span > 0)) continue;
    const points = n.bends?.length
      ? n.bends.map((b) => ({
          sec: n.startSec + Math.min(1, Math.max(0, b.pos)) * span,
          midi: n.midi + b.semis,
        }))
      : // Bendless note: a flat two-point line at the written pitch —
        // honest "no tracked deviation" evidence, not missing data.
        [
          { sec: n.startSec, midi: n.midi },
          { sec: n.endSec, midi: n.midi },
        ];
    out.push({ id: n.id, partIndex: n.partIndex, points });
  }
  return out;
}
