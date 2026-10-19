/**
 * #389: 区間ラベル → 楽譜のリハーサル記号。
 *
 * Region labels (Aメロ/サビ/…) live on the audio-time axis in the
 * waveform; this module maps their start positions onto the canonical
 * beat axis (same buildMsToBeat the waveform note overlay uses, so a
 * label sits on the same score position the note ticks do), finds the
 * containing measure via measureLayouts (the QNT-006 TS port), and
 * injects MusicXML <direction><rehearsal> elements into the LEAD part's
 * serialized document. Every consumer that renders or ships
 * scoreDoc.musicXml(view) — the verovio score view, print, and the
 * MusicXML/PDF export path — runs the same wrap, so the marks follow
 * the labels everywhere without touching the engine.
 *
 * A label landing mid-measure keeps its true position via <offset>
 * (divisions units); only when it sits (near-)exactly on the measure
 * head is the offset omitted. Multiple labels in one measure join into
 * a single mark text ("Aメロ / サビ") so the marks never collide.
 */
import { measureLayouts } from "./metronome";
import { parseFraction } from "./rhythmEdits";
import { buildMsToBeat } from "./swingWarp";
import type { RegionLabel } from "../workspace/regionLabels";

/** One rehearsal mark to render: MusicXML measure number + beat offset
 *  into it + the label text. */
export interface RehearsalMark {
  readonly measure: number;
  readonly offsetBeats: number;
  readonly text: string;
}

function num(raw: unknown): number | null {
  const f = parseFraction(raw);
  if (f) return f.num / f.den;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Labels → score-positioned marks. Null when the document cannot map
 *  (no canonical payload / no tempo map / no measure layout) — the
 *  callers then skip injection entirely. Labels before score start or
 *  past content end are dropped honestly (a mark with no measure is
 *  worse than no mark). */
export function rehearsalMarksFor(
  labels: readonly RegionLabel[],
  canonicalDocument: unknown,
): RehearsalMark[] | null {
  if (labels.length === 0) return [];
  const msToBeat = buildMsToBeat(canonicalDocument);
  const layouts = measureLayouts(canonicalDocument);
  if (!msToBeat || !layouts || layouts.length === 0) return null;
  const byMeasure = new Map<number, RehearsalMark>();
  const sorted = labels
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  for (const l of sorted) {
    const beat = msToBeat(l.startSec * 1000);
    if (!Number.isFinite(beat) || beat < 0) continue;
    const layout = layouts.find(
      (m) => beat >= m.startBeat && beat < m.endBeat,
    );
    if (!layout) continue;
    const existing = byMeasure.get(layout.number);
    if (existing) {
      // Same-measure labels merge so a single boxed mark carries both.
      if (!existing.text.split(" / ").includes(l.label)) {
        byMeasure.set(layout.number, {
          ...existing,
          text: existing.text + " / " + l.label,
        });
      }
      continue;
    }
    byMeasure.set(layout.number, {
      measure: layout.number,
      offsetBeats: Math.max(0, beat - layout.startBeat),
      text: l.label,
    });
  }
  return Array.from(byMeasure.values()).sort((a, b) => a.measure - b.measure);
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Head-meter quarterLength per canonical beat (4/beatUnit) — the
 *  axis <offset> divisions are measured against. 4/4 → 1.0. */
function headBeatQl(canonicalDocument: unknown): number {
  const doc = canonicalDocument as Record<string, unknown> | null;
  const content = doc?.["content"] as Record<string, unknown> | undefined;
  const ts = content?.["timeSignature"] as Record<string, unknown> | undefined;
  const unit = num(ts?.["beatUnit"]);
  return unit && unit > 0 ? 4 / unit : 1;
}

/**
 * Inject <direction><rehearsal> marks into the FIRST <part> of a
 * serialized score-partwise document. Returns the input untouched when
 * there is nothing to inject or the part structure does not match the
 * expected shape — never produces a corrupted document.
 */
export function withRehearsalMarks(
  xml: string,
  marks: readonly RehearsalMark[],
  canonicalDocument: unknown,
): string {
  if (marks.length === 0) return xml;
  const partStart = xml.indexOf("<part ");
  if (partStart < 0) return xml;
  const partEnd = xml.indexOf("</part>", partStart);
  if (partEnd < 0) return xml;
  const part = xml.slice(partStart, partEnd);
  const beatQl = headBeatQl(canonicalDocument);

  const wanted = new Map(marks.map((m) => [m.measure, m]));
  let lastDivisions: number | null = null;
  const out = part.replace(
    /<measure\b[^>]*>([\s\S]*?)<\/measure>/g,
    (whole, body: string, offset: number, full: string) => {
      const open = full.slice(offset, offset + whole.indexOf(">") + 1);
      const mNum = /number="(\d+)"/.exec(open);
      const mark = mNum ? wanted.get(Number(mNum[1])) : undefined;
      const divMatch = /<divisions>(\d+)<\/divisions>/.exec(body);
      const divisions = divMatch ? Number(divMatch[1]) : lastDivisions;
      if (divMatch) lastDivisions = Number(divMatch[1]);
      if (!mark) return whole;
      const offsetDiv =
        mark.offsetBeats > 0.02 && divisions
          ? Math.round(mark.offsetBeats * beatQl * divisions)
          : 0;
      const direction =
        '<direction placement="above">' +
        "<direction-type>" +
        '<rehearsal enclosure="box">' +
        escapeXml(mark.text) +
        "</rehearsal>" +
        "</direction-type>" +
        (offsetDiv > 0 ? "<offset>" + offsetDiv + "</offset>" : "") +
        "<staff>1</staff>" +
        "</direction>";
      // After <attributes>…</attributes> when present so the direction
      // inherits the measure's divisions; else right after the open tag.
      const attrs = /<attributes>[\s\S]*?<\/attributes>/.exec(body);
      if (attrs) {
        const at = whole.indexOf(attrs[0]) + attrs[0].length;
        return whole.slice(0, at) + direction + whole.slice(at);
      }
      const openEnd = whole.indexOf(">") + 1;
      return whole.slice(0, openEnd) + direction + whole.slice(openEnd);
    },
  );
  return xml.slice(0, partStart) + out + xml.slice(partEnd);
}
