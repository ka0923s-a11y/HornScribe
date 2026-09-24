/**
 * Score note edits (UI-050, GUI_UX_SPEC §13 簡易音符修正).
 *
 * The review workspace's correction set is deliberately narrow: semitone
 * pitch shift and delete/restore. Edits are expressed against canonical
 * `sn-*` note ids and applied to the document's MusicXML by
 * `applyNoteEdits` — the same transform runs on the concert and F管
 * presentations (identical `hs-sn-*` ids), so both views stay consistent
 * and any consumer of `musicXml()` sees the corrected document.
 *
 * Spelling policy: ascending shifts respell with sharps, descending with
 * flats — deterministic and direction-aware, matching the P4 prototype's
 * convention. Enharmonic re-spelling that keeps pitch is a separate spec
 * item and not part of this transform.
 */
import { canonicalNoteIdFromMusicxml } from "./ids";

/** One canonical note's user edit - cumulative, never incremental state. */
export interface ScoreNoteEdit {
  /** Semitone offset vs. the document's emitted pitch (0 = unchanged). */
  readonly pitchDelta: number;
  /** User deleted this note - rendered as a rest so measure timing stays
   *  intact (a removal would shift every later onset). */
  readonly deleted: boolean;
  /** #114 (spec 13): enharmonic respell toggle - the sounding pitch is
   *  unchanged; the written spelling flips to the other accidental
   *  family (sharp <-> flat). Applied after pitchDelta. */
  readonly enharmonic?: boolean;
}

/** The identity edit - absence of a map entry means the same thing. */
export const NO_NOTE_EDIT: ScoreNoteEdit = {
  pitchDelta: 0,
  deleted: false,
  enharmonic: false,
};

export function isEmptyNoteEdit(edit: ScoreNoteEdit): boolean {
  return (
    edit.pitchDelta === 0 && !edit.deleted && !(edit.enharmonic ?? false)
  );
}

const STEP_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** pitch class → [step, alter] spellings. Ascending shifts use sharps,
 *  descending use flats (so E+1 = F, D-1 = D♭ — never E♯/F♭ here). */
const SPELL_SHARP: ReadonlyArray<readonly [string, number]> = [
  ["C", 0],
  ["C", 1],
  ["D", 0],
  ["D", 1],
  ["E", 0],
  ["F", 0],
  ["F", 1],
  ["G", 0],
  ["G", 1],
  ["A", 0],
  ["A", 1],
  ["B", 0],
];
const SPELL_FLAT: ReadonlyArray<readonly [string, number]> = [
  ["C", 0],
  ["D", -1],
  ["D", 0],
  ["E", -1],
  ["E", 0],
  ["F", 0],
  ["G", -1],
  ["G", 0],
  ["A", -1],
  ["A", 0],
  ["B", -1],
  ["B", 0],
];

const ACCIDENTAL_NAME: Record<number, string> = {
  "-2": "flat-flat",
  "-1": "flat",
  "1": "sharp",
  "2": "double-sharp",
};

/**
 * Shift a spelled pitch by `delta` semitones and return the new
 * (step, alter, octave) spelling. Returns null for unspellable input.
 */
export function shiftPitch(
  step: string,
  alter: number,
  octave: number,
  delta: number,
): { step: string; alter: number; octave: number } | null {
  const pc0 = STEP_PC[step];
  if (pc0 === undefined || delta === 0) return null;
  const midi = (octave + 1) * 12 + pc0 + alter + delta;
  const pc = ((midi % 12) + 12) % 12;
  const [s, a] = (delta > 0 ? SPELL_SHARP : SPELL_FLAT)[pc];
  return { step: s, alter: a, octave: Math.floor(midi / 12) - 1 };
}

/** #114 (spec 13 異名同音): respell the SAME sounding pitch in the other
 *  accidental family (sharp <-> flat). Prefers a single accidental; when
 *  both candidates need a double accidental the flat family wins (B# ->
 *  C keeps naturals stable). Returns null for unspellable input. */
export function enharmonicRespell(
  step: string,
  alter: number,
  octave: number,
): { step: string; alter: number; octave: number } | null {
  const pc0 = STEP_PC[step];
  if (pc0 === undefined) return null;
  const midi = (octave + 1) * 12 + pc0 + alter;
  const pc = ((midi % 12) + 12) % 12;
  const sharp = SPELL_SHARP[pc];
  const flat = SPELL_FLAT[pc];
  const currentIsFlat = alter < 0;
  const [first, second] = currentIsFlat ? [sharp, flat] : [flat, sharp];
  const pick = Math.abs(first[1]) <= 1 ? first : second;
  // No-op guard: the other family is the same spelling (naturals).
  if (pick[0] === step && pick[1] === alter) return null;
  // STEP_PC+alter can leave [0,11] (B#=12, Cb=-1), so solve the octave
  // from midi - (step+alter) instead of midi/12.
  return {
    step: pick[0],
    alter: pick[1],
    octave: Math.floor((midi - (STEP_PC[pick[0]] + pick[1])) / 12) - 1,
  };
}

function setChildText(
  parent: Element,
  doc: XMLDocument,
  tag: string,
  text: string | null,
  before?: Element | null,
): void {
  const existing = parent.querySelector(`:scope > ${tag}`);
  if (text === null) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = text;
    return;
  }
  const el = doc.createElement(tag);
  el.textContent = text;
  parent.insertBefore(el, before ?? null);
}

/** Write a (step, alter, octave) spelling back into <pitch> and sync the
 *  <accidental> element so the rendered glyph matches. */
function writeSpelling(
  noteEl: Element,
  pitch: Element,
  doc: XMLDocument,
  next: { step: string; alter: number; octave: number },
): void {
  const octaveEl = pitch.querySelector("octave");
  setChildText(pitch, doc, "step", next.step, pitch.querySelector("alter") ?? octaveEl);
  setChildText(
    pitch,
    doc,
    "alter",
    next.alter === 0 ? null : String(next.alter),
    octaveEl,
  );
  setChildText(pitch, doc, "octave", String(next.octave));
  const acc = noteEl.querySelector(":scope > accidental");
  const accName = ACCIDENTAL_NAME[next.alter];
  if (accName === undefined) acc?.remove();
  else if (acc) acc.textContent = accName;
  else {
    const el = doc.createElement("accidental");
    el.textContent = accName;
    noteEl.appendChild(el);
  }
}

/** Read the note's current (step, alter, octave), or null for rests /
 *  unspellable pitches. */
function readSpelling(
  noteEl: Element,
): { step: string; alter: number; octave: number } | null {
  const pitch = noteEl.querySelector(":scope > pitch");
  if (!pitch) return null; // already a rest - nothing to transpose
  const step = pitch.querySelector("step")?.textContent ?? "";
  const alterText = pitch.querySelector("alter")?.textContent;
  const octaveText = pitch.querySelector("octave")?.textContent;
  const octave = octaveText != null ? Number(octaveText) : NaN;
  if (!Number.isFinite(octave) || !(step in STEP_PC)) return null;
  return { step, alter: alterText != null ? Number(alterText) : 0, octave };
}

/** Rewrite a <note>'s <pitch>/<alter>/<octave> and its <accidental> text
 *  so the rendered glyph matches the shifted sounding pitch. */
function shiftNotePitch(noteEl: Element, doc: XMLDocument, delta: number): void {
  const cur = readSpelling(noteEl);
  if (!cur) return;
  const next = shiftPitch(cur.step, cur.alter, cur.octave, delta);
  if (!next) return;
  writeSpelling(noteEl, noteEl.querySelector(":scope > pitch")!, doc, next);
}

/** #114: enharmonic respell - same sounding pitch, other accidental
 *  family (spec 13). */
function respellNotePitch(noteEl: Element, doc: XMLDocument): void {
  const cur = readSpelling(noteEl);
  if (!cur) return;
  const next = enharmonicRespell(cur.step, cur.alter, cur.octave);
  if (!next) return;
  writeSpelling(noteEl, noteEl.querySelector(":scope > pitch")!, doc, next);
}

/** Convert a pitched <note> into a same-duration rest, keeping the
 *  `hs-sn-*` id so canonical identity (selection, issue links) survives.
 *  Ties/notations/beams that only make sense for a pitch are dropped. */
function noteToRest(noteEl: Element, doc: XMLDocument): void {
  const pitch = noteEl.querySelector(":scope > pitch");
  if (!pitch) return; // already a rest
  const rest = doc.createElement("rest");
  noteEl.replaceChild(rest, pitch);
  for (const tag of ["accidental", "tie", "notations", "stem", "beam"] as const) {
    for (const el of Array.from(noteEl.querySelectorAll(`:scope > ${tag}`))) {
      el.remove();
    }
  }
}

/**
 * Apply canonical-note edits to a MusicXML document and return the new
 * XML string. Unedited input short-circuits to the original string so the
 * render path can tell "no change" apart cheaply.
 */
export function applyNoteEdits(
  xml: string,
  edits: ReadonlyMap<string, ScoreNoteEdit>,
): string {
  if (edits.size === 0) return xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("MusicXML parse failed");
  }
  let changed = false;
  for (const noteEl of Array.from(doc.querySelectorAll("note[id]"))) {
    const canonical = canonicalNoteIdFromMusicxml(noteEl.getAttribute("id") ?? "");
    if (!canonical) continue;
    const edit = edits.get(canonical);
    if (!edit) continue;
    if (edit.deleted) {
      noteToRest(noteEl, doc);
      changed = true;
    } else {
      // pitchDelta first, then the enharmonic respell of the shifted
      // pitch (edit semantics: respell applies to the edited spelling).
      if (edit.pitchDelta !== 0) {
        shiftNotePitch(noteEl, doc, edit.pitchDelta);
        changed = true;
      }
      if (edit.enharmonic) {
        respellNotePitch(noteEl, doc);
        changed = true;
      }
    }
  }
  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}
