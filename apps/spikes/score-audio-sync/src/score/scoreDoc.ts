/**
 * MusicXML → flat note/rest model used for the parallel accessible score
 * representation (GUI_UX_PLAN §40: a11y must not depend on raw SVG alone).
 * This is a presentation helper only — canonical identity still comes from
 * `hs-sn-*` ids, not from parse order.
 */
import { canonicalNoteIdFromMusicxml, isMusicxmlRestId } from './ids';

export interface ParsedNote {
  exportId: string; // MusicXML note/@id, e.g. hs-sn-000003-2 / hs-rest-000001
  canonicalId: string | null; // sn-000003, or null for rests
  isRest: boolean;
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
  notes: ParsedNote[];
  measureCount: number;
}

const TYPE_JA: Record<string, string> = {
  whole: '全',
  half: '二分',
  quarter: '四分',
  eighth: '八分',
  '16th': '十六分',
  '32nd': '三十二分',
  '64th': '六十四分',
};

export function noteTypeJa(note: ParsedNote): string {
  const base = TYPE_JA[note.type ?? ''] ?? (note.type ?? '');
  const dotted = note.dots > 0 ? '付点' : '';
  const unit = note.isRest ? '休符' : '音符';
  return `${dotted}${base}${unit}`.replace(/^付点$/, '');
}

export function pitchLabel(note: ParsedNote): string {
  if (note.isRest || note.step === undefined || note.octave === undefined) return '';
  const acc = note.alter === undefined || note.alter === 0 ? '' : note.alter > 0 ? '♯'.repeat(note.alter) : '♭'.repeat(-note.alter);
  return `${note.step}${acc}${note.octave}`;
}

/** e.g. "第3小節 B♭3 付点四分音符 (sn-000003)" / "第2小節 四分休符" */
export function describeNote(note: ParsedNote): string {
  const where = `第${note.measure}小節`;
  if (note.isRest) return `${where} ${noteTypeJa(note)}`;
  const pitch = pitchLabel(note);
  const tie = note.tied ? '・タイ' : '';
  return `${where} ${pitch} ${noteTypeJa(note)}${tie}`;
}

export function parseScoreDoc(xml: string): ScoreDoc {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const title =
    doc.querySelector('movement-title')?.textContent?.trim() ||
    doc.querySelector('work-title')?.textContent?.trim() ||
    '';
  const notes: ParsedNote[] = [];
  let measureCount = 0;
  for (const measure of Array.from(doc.querySelectorAll('part > measure'))) {
    const number = Number(measure.getAttribute('number') ?? measureCount + 1);
    measureCount = Math.max(measureCount, Number.isFinite(number) ? number : measureCount + 1);
    for (const noteEl of Array.from(measure.querySelectorAll(':scope > note'))) {
      const exportId = noteEl.getAttribute('id') ?? '';
      const isRest = noteEl.querySelector('rest') !== null || isMusicxmlRestId(exportId);
      const pitchEl = noteEl.querySelector('pitch');
      const alterText = pitchEl?.querySelector('alter')?.textContent;
      const tied =
        noteEl.querySelector('tie[type="start"], tie[type="stop"]') !== null ||
        noteEl.querySelector('notations > tied') !== null;
      notes.push({
        exportId,
        canonicalId: canonicalNoteIdFromMusicxml(exportId),
        isRest,
        measure: number,
        step: pitchEl?.querySelector('step')?.textContent ?? undefined,
        alter: alterText !== undefined && alterText !== null ? Number(alterText) : undefined,
        octave: pitchEl?.querySelector('octave')?.textContent
          ? Number(pitchEl.querySelector('octave')!.textContent)
          : undefined,
        type: noteEl.querySelector('type')?.textContent ?? undefined,
        dots: noteEl.querySelectorAll('dot').length,
        tied,
      });
    }
  }
  return { title, notes, measureCount };
}
