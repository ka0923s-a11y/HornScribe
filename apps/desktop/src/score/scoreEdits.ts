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

/** One canonical note's user edit — cumulative, never incremental state. */
export interface ScoreNoteEdit {
  /** Semitone offset vs. the document's emitted pitch (0 = unchanged). */
  readonly pitchDelta: number;
  /** User deleted this note — rendered as a rest so measure timing stays
   *  intact (a removal would shift every later onset). */
  readonly deleted: boolean;
}

/** The identity edit — absence of a map entry means the same thing. */
export const NO_NOTE_EDIT: ScoreNoteEdit = { pitchDelta: 0, deleted: false };

export function isEmptyNoteEdit(edit: ScoreNoteEdit): boolean {
  return edit.pitchDelta === 0 && !edit.deleted;
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

/** Rewrite a <note>'s <pitch>/<alter>/<octave> and its <accidental> text
 *  so the rendered glyph matches the shifted sounding pitch. */
function shiftNotePitch(noteEl: Element, doc: XMLDocument, delta: number): void {
  const pitch = noteEl.querySelector(":scope > pitch");
  if (!pitch) return; // already a rest — nothing to transpose
  const step = pitch.querySelector("step")?.textContent ?? "";
  const alterText = pitch.querySelector("alter")?.textContent;
  const octaveText = pitch.querySelector("octave")?.textContent;
  const octave = octaveText != null ? Number(octaveText) : NaN;
  if (!Number.isFinite(octave)) return;
  const next = shiftPitch(step, alterText != null ? Number(alterText) : 0, octave, delta);
  if (!next) return;
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
    } else if (edit.pitchDelta !== 0) {
      shiftNotePitch(noteEl, doc, edit.pitchDelta);
      changed = true;
    }
  }
  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}
