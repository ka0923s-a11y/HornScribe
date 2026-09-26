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
      });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}
