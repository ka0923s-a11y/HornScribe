/**
 * MusicXML → flat note/rest model used for the properties inspector and the
 * accessible score representation (GUI_UX_SPEC §24: a11y must not depend on
 * raw SVG alone). This is a presentation helper only — canonical identity
 * still comes from `hs-sn-*` ids, not from parse order.
 */
import { canonicalNoteIdFromMusicxml, isMusicxmlRestId } from "./ids";

/** MusicXML <mode> values the engine emits (domain/score.py KeySignature). */
export type KeyMode = "major" | "minor";

/** Parse a MusicXML <mode> text into the domain mode; anything
 *  unrecognized (dorian, none, ...) maps to null so callers keep the
 *  major default rather than trusting a free-form string. */
export function parseKeyMode(text: string | null | undefined): KeyMode | null {
  if (text === "major" || text === "minor") return text;
  return null;
}

export interface ParsedNote {
  exportId: string; // MusicXML note/@id, e.g. hs-sn-000003-2 / hs-rest-000001
  canonicalId: string | null; // sn-000003, or null for rests
  isRest: boolean;
  chord: boolean;
  measure: number;
  step?: string;
  alter?: number;
  octave?: number;
  type?: string;
  dots: number;
  /** This note is a member of a tie chain (start/stop). */
  tied: boolean;
}

export interface ScoreDoc {
  title: string;
  /** #271: <creator type="composer"> — null when the document has none. */
  composer: string | null;
  /** #271: <creator type="arranger"> — null when the document has none. */
  arranger: string | null;
  notes: ParsedNote[];
  measureCount: number;
  /** `<sound tempo>` beats per minute, when present. */
  tempoBpm: number | null;
  /** Time signature like "4/4", when present. */
  meter: string | null;
  /** Key signature fifths (−7…+7), when present. */
 keyFifths: number | null;
  /** #252: key mode (major/minor) when the document declares one; null
   *  keeps the major default for legacy MusicXML without <mode>. */
  keyMode: KeyMode | null;
  /** #146: key changes with their measure numbers, head first. Empty
   *  or single-entry = the piece stays in keyFifths. */
  keyChanges: { measure: number; fifths: number; mode: KeyMode | null }[];
  /** #249: tempo marks in document order — each <sound tempo> with the
   *  number of the measure that carries it (head first). */
  tempoChanges: { measure: number; bpm: number }[];
  /** #134: a <sound><swing> direction exists — the piece is marked
   *  as swung (straight eighths play in the detected ratio). */
  swingFeel: boolean;
}

const TYPE_JA: Record<string, string> = {
  whole: "全",
  half: "二分",
  quarter: "四分",
  eighth: "八分",
  "16th": "十六分",
  "32nd": "三十二分",
  "64th": "六十四分",
};

export function noteTypeJa(note: ParsedNote): string {
  const base = TYPE_JA[note.type ?? ""] ?? (note.type ?? "");
  const dotted = note.dots > 0 ? "付点" : "";
  const unit = note.isRest ? "休符" : "音符";
  return `${dotted}${base}${unit}`.replace(/^付点$/, "");
}

export function pitchLabel(note: ParsedNote): string {
  if (note.isRest || note.step === undefined || note.octave === undefined) return "";
  const acc =
    note.alter === undefined || note.alter === 0
      ? ""
      : note.alter > 0
        ? "♯".repeat(note.alter)
        : "♭".repeat(-note.alter);
  return `${note.step}${acc}${note.octave}`;
}

/** e.g. "第3小節 B♭3 付点四分音符 (sn-000003)" / "第2小節 四分休符" */
export function describeNote(note: ParsedNote): string {
  const where = `第${note.measure}小節`;
  if (note.isRest) return `${where} ${noteTypeJa(note)}`;
  const pitch = pitchLabel(note);
  const tie = note.tied ? "・タイ" : "";
  return `${where} ${pitch} ${noteTypeJa(note)}${tie}`;
}

export function parseScoreDoc(xml: string): ScoreDoc {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("MusicXML parse failed");
  }
  const title =
    doc.querySelector("movement-title")?.textContent?.trim() ||
    doc.querySelector("work-title")?.textContent?.trim() ||
    "";
  // #271: notation metadata — first <creator> of each role wins;
  // absent/blank stays null so empty creators never surface.
  const creatorOf = (type: string): string | null => {
    for (const el of Array.from(
      doc.querySelectorAll("identification > creator"),
    )) {
      if (el.getAttribute("type") === type) {
        return el.textContent?.trim() || null;
      }
    }
    return null;
  };
  const composer = creatorOf("composer");
  const arranger = creatorOf("arranger");
  const tempoText = doc.querySelector("sound[tempo]")?.getAttribute("tempo");
  const tempoBpm =
    tempoText != null && Number.isFinite(Number(tempoText)) ? Number(tempoText) : null;
  const beats = doc.querySelector("time > beats")?.textContent?.trim();
  const beatType = doc.querySelector("time > beat-type")?.textContent?.trim();
  const meter = beats && beatType ? `${beats}/${beatType}` : null;
  const fifthsText = doc.querySelector("key > fifths")?.textContent;
 const keyFifths =
   fifthsText != null && Number.isFinite(Number(fifthsText)) ? Number(fifthsText) : null;
  const keyMode = parseKeyMode(
    doc.querySelector("key > mode")?.textContent?.trim(),
  );
  // #134: the engine emits <sound><swing> on swing-detected scores.
  const swingFeel = doc.querySelector("sound > swing") !== null;

  const notes: ParsedNote[] = [];
  let measureCount = 0;
  const keyChanges: { measure: number; fifths: number; mode: KeyMode | null }[] = [];
  const tempoChanges: { measure: number; bpm: number }[] = [];
  const parts = Array.from(doc.querySelectorAll("part"));
  for (const measure of Array.from(
    parts[0]?.querySelectorAll(":scope > measure") ?? [],
  )) {
    const number = Number(measure.getAttribute("number") ?? measureCount + 1);
    // #249: every tempo mark the measure carries — direct <sound> and
    // direction-embedded marks alike, in document order (the canonical
    // tempo map emits one mark per segment in the same order).
    for (const soundEl of Array.from(
      measure.querySelectorAll(":scope > sound[tempo], :scope > direction > sound[tempo]"),
    )) {
      const t = soundEl.getAttribute("tempo");
      if (t != null && Number.isFinite(Number(t))) {
        tempoChanges.push({ measure: number, bpm: Number(t) });
      }
    }
    // Mid-piece key changes (#133): every <key> under attributes —
    // a measure can carry more than one (offset insertions share the
    // element), so collect them all.
    for (const keyEl of Array.from(
      measure.querySelectorAll(":scope > attributes > key"),
    )) {
     const f = keyEl.querySelector("fifths")?.textContent;
     if (f != null && Number.isFinite(Number(f))) {
        keyChanges.push({
          measure: number,
          fifths: Number(f),
          mode: parseKeyMode(keyEl.querySelector("mode")?.textContent?.trim()),
        });
     }
    }
  }
  for (const measure of Array.from(doc.querySelectorAll("part > measure"))) {
    const number = Number(measure.getAttribute("number") ?? measureCount + 1);
    measureCount = Math.max(measureCount, Number.isFinite(number) ? number : measureCount + 1);
    for (const noteEl of Array.from(measure.querySelectorAll(":scope > note"))) {
      const exportId = noteEl.getAttribute("id") ?? "";
      const isRest =
        noteEl.querySelector(":scope > rest") !== null || isMusicxmlRestId(exportId);
      const pitchEl = noteEl.querySelector(":scope > pitch");
      const alterText = pitchEl?.querySelector("alter")?.textContent;
      const tied =
        noteEl.querySelector('tie[type="start"], tie[type="stop"]') !== null ||
        noteEl.querySelector("notations > tied") !== null;
      notes.push({
        exportId,
        canonicalId: canonicalNoteIdFromMusicxml(exportId),
        isRest,
        chord: noteEl.querySelector(":scope > chord") !== null,
        measure: number,
        step: pitchEl?.querySelector("step")?.textContent ?? undefined,
        alter:
          alterText !== undefined && alterText !== null ? Number(alterText) : undefined,
        octave: pitchEl?.querySelector("octave")?.textContent
          ? Number(pitchEl.querySelector("octave")!.textContent)
          : undefined,
        type: noteEl.querySelector(":scope > type")?.textContent ?? undefined,
        dots: noteEl.querySelectorAll(":scope > dot").length,
        tied,
      });
    }
  }
  return { title, composer, arranger, notes, measureCount, tempoBpm, meter, keyFifths, keyMode, keyChanges, tempoChanges, swingFeel };
}

/** canonical id → parsed fragments (both tie fragments and chords land here). */
export function notesByCanonical(doc: ScoreDoc): Map<string, ParsedNote[]> {
  const map = new Map<string, ParsedNote[]>();
  for (const note of doc.notes) {
    if (!note.canonicalId) continue;
    const list = map.get(note.canonicalId) ?? [];
    list.push(note);
    map.set(note.canonicalId, list);
  }
  return map;
}

/** Canonical note order — first occurrence wins, so the 2–3 MusicXML
 *  fragments of one tied canonical note collapse to a single step while
 *  chord members (distinct canonicalIds) keep their own entries. Rests
 *  carry no canonicalId and stay out. This is the order ←/→ note
 *  navigation walks (#368): without the dedupe, `indexOf` lands on the
 *  first fragment forever and a tied note can never be stepped past. */
export function canonicalNoteOrder(doc: ScoreDoc): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const note of doc.notes) {
    if (note.canonicalId && !seen.has(note.canonicalId)) {
      seen.add(note.canonicalId);
      order.push(note.canonicalId);
    }
  }
  return order;
}

/** export id → parsed note (includes rests, keyed by their hs-rest-* id). */
export function notesByExportId(doc: ScoreDoc): Map<string, ParsedNote> {
  const map = new Map<string, ParsedNote>();
  for (const note of doc.notes) map.set(note.exportId, note);
  return map;
}
