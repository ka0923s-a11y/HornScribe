/**
 * #163: map a clicked rest glyph (hs-rest-<ordinal>) back to the
 * canonical rest atom it renders.
 *
 * Rests carry no canonical ids — ScoreRest spans are presentation-only,
 * so the export numbers every rest <note> element hs-rest-1,2,3,... in
 * document order, exactly one element per rest ATOM (a multi-atom rest
 * span renders one glyph per atom). Walking the canonical payload's
 * rest atoms in part order therefore recovers (partId, atom startBeat,
 * atom durationBeats) for any ordinal — the data a restToNote edit
 * needs.
 *
 * #241: layout-only filler rests (secondary-voice gaps, non-strict
 * measure padding) are exported as hs-layout-rest-* instead — they
 * never consume an hs-rest-* ordinal, so the ordinal <-> canonical
 * atom mapping below stays exact even in multi-voice scores.
 */
import {
  parseFraction,
  type BeatFraction,
} from "./rhythmEdits";

export interface RestAtomTarget {
  readonly partId: string;
  /** Onset of the clicked rest atom, canonical beats. */
  readonly startBeat: BeatFraction;
  /** Duration of the clicked rest atom, canonical beats. */
  readonly durationBeats: BeatFraction;
}

/** Parse the ordinal out of an hs-rest-* export id (null otherwise). */
export function restOrdinalOf(exportId: string): number | null {
  const m = /^hs-rest-(\d{6})$/.exec(exportId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Resolve the 1-based rest-atom ordinal to its canonical target, or null
 * when the payload has no rest atom at that position.
 */
export function restAtomAtOrdinal(
  canonicalDocument: unknown,
  ordinal: number): RestAtomTarget | null {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content =
    (doc && doc["content"]) as Record<string, unknown> | undefined;
  const parts = content && content["parts"];
  if (!Array.isArray(parts)) return null;
  let seen = 0;
  for (const rawPart of parts) {
    const part = rawPart as Record<string, unknown>;
    const partId = typeof part["id"] === "string" ? part["id"] : null;
    const rests = part["rests"];
    if (partId == null || !Array.isArray(rests)) continue;
    for (const rawRest of rests) {
      const rest = rawRest as Record<string, unknown>;
      const restStart = parseFraction(rest["startBeat"]);
      const atoms = rest["atoms"];
      if (restStart == null || !Array.isArray(atoms)) continue;
      // Atom onsets accumulate inside the span.
      let atomStart = restStart;
      for (const rawAtom of atoms) {
        const atom = rawAtom as Record<string, unknown>;
        const dur = parseFraction(atom["durationBeats"]);
        if (dur == null) continue;
        seen += 1;
        if (seen === ordinal) {
          return {
            partId,
            startBeat: atomStart,
            durationBeats: dur,
          };
        }
        const num = atomStart.num * dur.den + dur.num * atomStart.den;
        const den = atomStart.den * dur.den;
        const reduced = parseFraction(num + "/" + den);
        atomStart = reduced != null ? reduced : { num, den };
      }
    }
  }
  return null;
}

/** Highest sn-* ordinal across every part — the id the engine's
 *  restToNote will assign (mirrors _next_score_note_id). */
export function nextScoreNoteId(canonicalDocument: unknown): string {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content =
    (doc && doc["content"]) as Record<string, unknown> | undefined;
  const parts = content && content["parts"];
  let next = 0;
  if (Array.isArray(parts)) {
    for (const rawPart of parts) {
      const notes = (rawPart as Record<string, unknown>)["notes"];
      if (!Array.isArray(notes)) continue;
      for (const rawNote of notes) {
        const id = (rawNote as Record<string, unknown>)["id"];
        const m = typeof id === "string" ? /^sn-(\d+)$/.exec(id) : null;
        if (m) next = Math.max(next, Number(m[1]) + 1);
      }
    }
  }
  return "sn-" + String(next).padStart(6, "0");
}

/** Pitch of the last canonical note ending at or before startBeat — the
 *  sensible default for a rest->note conversion (the user adjusts with
 *  the normal pitch edit afterwards). Falls back to C4 (60). */
export function pitchBefore(
  canonicalDocument: unknown,
  partId: string,
  startBeat: BeatFraction): number {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content =
    (doc && doc["content"]) as Record<string, unknown> | undefined;
  const parts = content && content["parts"];
  if (!Array.isArray(parts)) return 60;
  const target = startBeat.num / startBeat.den;
  let best: { end: number; pitch: number } | null = null;
  for (const rawPart of parts) {
    const part = rawPart as Record<string, unknown>;
    if (part["id"] !== partId) continue;
    const notes = part["notes"];
    if (!Array.isArray(notes)) continue;
    for (const rawNote of notes) {
      const note = rawNote as Record<string, unknown>;
      const start = parseFraction(note["startBeat"]);
      const dur = parseFraction(note["durationBeats"]);
      const pitch = note["pitchMidi"];
      if (start == null || dur == null || typeof pitch !== "number") {
        continue;
      }
      const end = start.num / start.den + dur.num / dur.den;
      if (end <= target && (best == null || end > best.end)) {
        best = { end, pitch };
      }
    }
  }
  return best ? best.pitch : 60;
}
