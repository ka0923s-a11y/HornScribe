/**
 * #115 (GUI_UX_SPEC §13): rhythm edits that re-realize notation through
 * the engine's score.edit method.
 *
 * Pitch/delete/respell edits rewrite MusicXML client-side; the three
 * timing edits (duration change, onset grid shift, tie toggle) change
 * the canonical payload, so the engine re-decomposes the affected
 * measures with the same SpanRealizer the quantizer used and returns
 * fresh MusicXML + a new scoreRevision (content-derived).
 *
 * The desktop keeps the edit on the shared undo stack by snapshotting
 * the document's XML bodies before the call and swapping them back on
 * undo — see ReviewSession.commitDocSwap.
 */

/** Edit kinds the engine's score.edit accepts (transcription/scoreedit.py). */
export type RhythmEditKind =
  | "setDuration"
  | "shiftOnset"
  | "toggleTie"
  | "setTempo"
  | "setMeter"
  | "requantize"
  | "splitNote"
  | "mergeNotes"
  | "setKey"
  | "keyChangeAt"
  | "removeKeyChange"
  | "restToNote"
  | "scaleTempo"
  | "applyAlternative"
  | "applyTriplet"
  | "setMetadata";

/** One rhythm edit request — mirrors ScoreEdit.from_dict on the engine. */
export interface RhythmEditOp {
  readonly kind: RhythmEditKind;
  /** Canonical `sn-*` note id. */
  readonly noteId: string;
  /** setDuration only: new written length as a "n/d" beat fraction. */
  readonly durationBeats?: string;
  /** shiftOnset only: signed count of minimum-grid steps. */
  readonly steps?: number;
  /** setTempo only: new head tempo (20-400, engine-validated). */
  readonly bpm?: number;
  /** scaleTempo only (#198): tempo-map multiplier — note values and
   *  every beat-axis boundary scale by the same factor, so playback
   *  seconds stay invariant (the real tempo-octave fix). */
  readonly factor?: number;
  /** applyAlternative only (#208): the runner-up spans embedded in
   *  the quantization_ambiguous issue's evidence — each entry swaps
   *  one canonical note's position/duration (id survives). */
  readonly notes?: readonly {
    readonly id: string;
    readonly startBeat: string;
    readonly durationBeats: string;
  }[];
  /** setMeter only: new time signature (engine-validated). */
  readonly beatsPerMeasure?: number;
  readonly beatUnit?: number;
  /** requantize only: quantization-settings overrides merged into the
   *  payload's stored settings (minDurationQl / triplets / simplicity). */
  readonly settings?: Record<string, unknown>;
  /** setKey/keyChangeAt only: signature fifths (-7..+7). */
  readonly fifths?: number;
  /** setKey/keyChangeAt only: major/minor (kept from the score when absent). */
  readonly mode?: "major" | "minor";
  /** keyChangeAt/removeKeyChange only: boundary beat ("n/d" fraction). */
  readonly startBeat?: string;
  /** keyChangeAt/removeKeyChange only (#145): boundary measure number
   *  — the UI names barlines; the engine resolves the beat. Mutually
   *  exclusive with startBeat. */
  readonly startMeasure?: number;
  /** restToNote only: target part id (rests carry no canonical note id).
   *  startBeat is the new note's onset inside the rest span. */
  readonly partId?: string;
  /** restToNote only: MIDI pitch of the new note (0-127). */
  readonly pitchMidi?: number;
  /** setMetadata only (#271): notation metadata — present keys are
   *  applied verbatim ("" clears), absent keys keep. */
  readonly metadata?: {
    readonly title?: string;
    readonly composer?: string;
    readonly arranger?: string;
  };
}

/** What score.edit returns — the rebuilt canonical payload + fresh XML. */
export interface ScoreEditResult {
  readonly scoreDocument: unknown;
  readonly scoreRevision: string;
  readonly musicXmlConcert: string;
  readonly musicXmlHornF: string;
}

/** The engine call the workspace delegates to (session.applyScoreEdit). */
export type RhythmEditInvoker = (
  scoreDocument: unknown,
  op: RhythmEditOp,
) => Promise<ScoreEditResult>;

/** A reduced "n/d" beat fraction (the canonical payload's wire form). */
export interface BeatFraction {
  readonly num: number;
  readonly den: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Parse a "n/d" beat fraction; null when the shape is not a fraction. */
export function parseFraction(raw: unknown): BeatFraction | null {
  if (typeof raw !== "string") return null;
  const m = /^(-?\d+)\/(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    return null;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** Serialize back to the canonical "n/d" wire form. */
export function formatFraction(f: BeatFraction): string {
  return `${f.num}/${f.den}`;
}

/**
 * Scale a beat fraction by 2^power (power ∈ {-1, +1} for the duration
 * ladder). Returns null when the result would leave the safe-integer
 * range — the caller treats that as "cannot apply", never clamps.
 */
export function scaleFraction(
  f: BeatFraction,
  power: number,
): BeatFraction | null {
  let { num, den } = f;
  if (power > 0) {
    // ×2 per step: halve the denominator when possible, else double
    // the numerator — the fraction stays exact.
    for (let i = 0; i < power; i += 1) {
      if (den % 2 === 0) den /= 2;
      else num *= 2;
      if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
        return null;
      }
    }
  } else {
    // ÷2 per step.
    for (let i = 0; i < -power; i += 1) {
      if (num % 2 === 0) num /= 2;
      else den *= 2;
      if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
        return null;
      }
    }
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** What a duration/onset edit needs to know about the target note. */
export interface CanonicalNoteTiming {
  readonly noteId: string;
  readonly startBeat: BeatFraction;
  readonly durationBeats: BeatFraction;
  readonly pitchMidi: number;
}

/**
 * Find one canonical note inside a scoreDocument dict (schema v1:
 * `{ content: { parts: [{ notes: [...] }] } }`). Returns null when the
 * document or the note is missing — callers treat that as "cannot edit"
 * rather than guessing.
 */
export function findCanonicalNote(
  scoreDocument: unknown,
  noteId: string,
): CanonicalNoteTiming | null {
  if (typeof scoreDocument !== "object" || scoreDocument === null) {
    return null;
  }
  const content = (scoreDocument as Record<string, unknown>).content;
  if (typeof content !== "object" || content === null) return null;
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const notes = (part as Record<string, unknown>).notes;
    if (!Array.isArray(notes)) continue;
    for (const note of notes) {
      if (typeof note !== "object" || note === null) continue;
      const n = note as Record<string, unknown>;
      if (n.id !== noteId) continue;
      const startBeat = parseFraction(n.startBeat);
      const durationBeats = parseFraction(n.durationBeats);
      const pitchMidi =
        typeof n.pitchMidi === "number" ? n.pitchMidi : null;
      if (!startBeat || !durationBeats || pitchMidi === null) return null;
      return { noteId, startBeat, durationBeats, pitchMidi };
    }
  }
  return null;
}
