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
 *  hs-sn-* id so canonical identity (selection, issue links) survives.
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

/** #224: reverse of noteToRest for CANONICAL-deleted notes — the
 *  engine emits them as rests that keep their hs-sn-* id, so an
 *  overlay restore (deleted:false) re-pitches the element from the
 *  canonical pitchMidi (sharp-family spelling, alter implied). */
function restToNote(
  noteEl: Element,
  doc: XMLDocument,
  midi: number,
): void {
  const restEl = noteEl.querySelector(":scope > rest");
  if (!restEl) return;
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] = SPELL_SHARP[pc];
  const octave = Math.floor(midi / 12) - 1;
  const pitch = doc.createElement("pitch");
  const stepEl = doc.createElement("step");
  stepEl.textContent = step;
  pitch.appendChild(stepEl);
  if (alter !== 0) {
    const alterEl = doc.createElement("alter");
    alterEl.textContent = String(alter);
    pitch.appendChild(alterEl);
  }
  const octaveEl = doc.createElement("octave");
  octaveEl.textContent = String(octave);
  pitch.appendChild(octaveEl);
  noteEl.replaceChild(pitch, restEl);
}

/** #224: canonical id -> pitchMidi lookup for restore. */
function canonicalMidiOf(
  canonicalDoc: unknown,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  const content = (canonicalDoc as { content?: { parts?: unknown } })
    ?.content;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return map;
  for (const part of parts) {
    const notes = (part as { notes?: unknown }).notes;
    if (!Array.isArray(notes)) continue;
    for (const n of notes) {
      const note = n as { id?: unknown; pitchMidi?: unknown };
      if (
        typeof note.id === "string" &&
        typeof note.pitchMidi === "number"
      ) {
        map.set(note.id, note.pitchMidi);
      }
    }
  }
  return map;
}

/** #246: after deletions, rebuild each <chord/> group so the MusicXML
 *  stays structurally valid. A chord group is a pitched root <note>
 *  followed by <note> elements carrying <chord/>; deletions can leave
 *  a chord-rest (<chord/><rest/>), a rest-root with pitched members
 *  dangling off it, or several same-position rests where one member
 *  survived. Walk each measure's direct children (voices are separated
 *  by <backup>/<forward>, which also break a group) and normalize:
 *  - first surviving pitched member becomes the root (its <chord/> is
 *    removed);
 *  - rest members inside a group are dropped (a chord rest is
 *    meaningless — the surviving members already occupy the slot);
 *  - a group with no pitched member collapses to a single rest. */
function normalizeChords(doc: XMLDocument): void {
  const isPitched = (el: Element): boolean =>
    el.querySelector(":scope > pitch") !== null;
  const isChordMember = (el: Element): boolean =>
    el.querySelector(":scope > chord") !== null;
  const dropChordTag = (el: Element): void => {
    for (const c of Array.from(el.querySelectorAll(":scope > chord"))) {
      c.remove();
    }
  };

  const flush = (group: Element[]): void => {
    if (group.length === 0) return;
    const pitched = group.filter(isPitched);
    if (pitched.length === 0) {
      // All members deleted: keep ONE rest for the slot, drop the rest.
      const [keep, ...extra] = group;
      dropChordTag(keep);
      for (const el of extra) el.remove();
      return;
    }
    // Promote the first pitched member to root, then drop rest members
    // (their duration is already covered by the surviving chord).
    dropChordTag(pitched[0]);
    for (const el of group) {
      if (!isPitched(el)) el.remove();
    }
  };

  for (const measure of Array.from(doc.querySelectorAll("measure"))) {
    let group: Element[] = [];
    for (const child of Array.from(measure.children)) {
      if (child.tagName === "note") {
        if (isChordMember(child)) {
          group.push(child);
        } else {
          flush(group);
          group = [child];
        }
      } else if (child.tagName === "backup" || child.tagName === "forward") {
        flush(group);
        group = [];
      }
    }
    flush(group);
  }
}

/**
 * Apply canonical-note edits to a MusicXML document and return the new
 * XML string. Unedited input short-circuits to the original string so the
 * render path can tell "no change" apart cheaply.
 */
/* #232: after deletions/respells, strip ties whose partner is gone.
 * A tie binds CONSECUTIVE onsets in the same voice+staff at the same
 * pitch — so when the note carrying the <tie type="stop"/> is
 * deleted, the previous onset's <tie type="start"/> dangles and
 * renders a stub arc (Verovio: "There are N ties left open"), and
 * a pitch shift breaks the pair the same way by desyncing the keys.
 * Walk each part's onsets — a note plus its <chord/> members — in
 * document order:
 * - each onset's stop-ties consume pitch-matched open starts;
 * - open starts left unmatched at the next onset of the same voice
 *   are dangling (a tie can never skip an onset) — strip them;
 * - a stop with no open start is dangling too — strip it;
 * - a rest is an onset with no ties: it closes every open start in
 *   its voice (that is exactly the deleted-tie-partner case).
 * <tie>/<tied> types other than start/stop are left alone. */
function stripDanglingTies(doc: XMLDocument): void {
  const strip = (noteEl: Element, type: "start" | "stop"): void => {
    for (const el of Array.from(noteEl.querySelectorAll(":scope > tie"))) {
      if (el.getAttribute("type") === type) el.remove();
    }
    for (const not of Array.from(
      noteEl.querySelectorAll(":scope > notations"),
    )) {
      for (const tied of Array.from(
        not.querySelectorAll(":scope > tied"),
      )) {
        if (tied.getAttribute("type") === type) tied.remove();
      }
      if (not.childElementCount === 0) not.remove();
    }
  };
  const voiceKey = (el: Element): string =>
    (el.querySelector(":scope > voice")?.textContent ?? "1") +
    "|" +
    (el.querySelector(":scope > staff")?.textContent ?? "");
  const pitchKey = (el: Element): string => {
    const step =
      el.querySelector(":scope > pitch > step")?.textContent ?? "";
    const alter =
      el.querySelector(":scope > pitch > alter")?.textContent ?? "0";
    const octave =
      el.querySelector(":scope > pitch > octave")?.textContent ?? "";
    return `${step}|${alter}|${octave}`;
  };
  const hasTie = (el: Element, type: string): boolean =>
    Array.from(el.querySelectorAll(":scope > tie")).some(
      (t) => t.getAttribute("type") === type,
    );

  for (const part of Array.from(doc.querySelectorAll("part"))) {
    // voice|staff|pitch -> note elements holding an open tie start.
    const open = new Map<string, Element[]>();
    // Onsets arrive in document order; <chord/> members belong to the
    // onset the preceding non-chord note opened.
    let onset: Element[] = [];
    const flushOnset = (): void => {
      if (onset.length === 0) return;
      const onsetVoice = voiceKey(onset[0]);
      // 1. this onset's stops consume pitch-matched open starts
      for (const el of onset) {
        if (!hasTie(el, "stop")) continue;
        const key = voiceKey(el) + "|" + pitchKey(el);
        const list = open.get(key);
        if (list && list.length > 0) {
          list.pop();
          if (list.length === 0) open.delete(key);
        } else {
          strip(el, "stop");
        }
      }
      // 2. opens of THIS voice that remain are dangling — a tie can
      //    only bind the very next onset of its own voice.
      for (const [key, els] of open) {
        if (!key.startsWith(onsetVoice + "|")) continue;
        for (const el of els) strip(el, "start");
        open.delete(key);
      }
      // 3. register this onset's starts as the new opens
      for (const el of onset) {
        if (!hasTie(el, "start")) continue;
        const key = voiceKey(el) + "|" + pitchKey(el);
        const list = open.get(key) ?? [];
        list.push(el);
        open.set(key, list);
      }
      onset = [];
    };
    for (const noteEl of Array.from(part.querySelectorAll("note"))) {
      if (noteEl.querySelector(":scope > chord") !== null) {
        onset.push(noteEl);
      } else {
        flushOnset();
        onset = [noteEl];
      }
    }
    flushOnset();
    // Part end: opens that never met their stop are dangling.
    for (const [, els] of open) {
      for (const el of els) strip(el, "start");
    }
    open.clear();
  }
}

export function applyNoteEdits(
  xml: string,
  edits: ReadonlyMap<string, ScoreNoteEdit>,
  canonicalDoc?: unknown,
): string {
  if (edits.size === 0) return xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("MusicXML parse failed");
  }
  const midiById =
    canonicalDoc !== undefined ? canonicalMidiOf(canonicalDoc) : null;
  let changed = false;
  for (const noteEl of Array.from(doc.querySelectorAll("note[id]"))) {
    const canonical = canonicalNoteIdFromMusicxml(noteEl.getAttribute("id") ?? "");
    if (!canonical) continue;
    const edit = edits.get(canonical);
    if (!edit) continue;
    const isRest = noteEl.querySelector(":scope > rest") !== null;
    if (isRest && !edit.deleted) {
      // #224: restore — a canonical-deleted note re-pitches from the
      // canonical pitchMidi, then pitchDelta/enharmonic apply on top.
      const midi = midiById?.get(canonical);
      if (midi !== undefined) {
        restToNote(noteEl, doc, midi);
        changed = true;
        if (edit.pitchDelta !== 0) {
          shiftNotePitch(noteEl, doc, edit.pitchDelta);
        }
        if (edit.enharmonic) {
          respellNotePitch(noteEl, doc);
        }
      }
    } else if (edit.deleted) {
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
  if (!changed) return xml;
  normalizeChords(doc);
  // #232: normalizeChords can also orphan a tie's partner (a deleted
  // chord member), so the dangling sweep runs after it, not before.
  stripDanglingTies(doc);
  return new XMLSerializer().serializeToString(doc);
}
