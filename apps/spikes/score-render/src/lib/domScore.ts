/**
 * DOM-side helpers for the rendered Verovio SVG.
 *
 * Verovio mirrors the MusicXML `note/@id` onto the rendered element
 * (`<g class="note" id="hs-sn-000003">`), so a rendered element can be looked
 * up by export id and resolved to a canonical `sn-*` id. Highlighting is a
 * pure `classList` toggle — no re-render (measured in the spike results).
 */
import { canonicalNoteIdFromMusicxml, isMusicxmlNoteId } from './ids';

export interface ElementIndex {
  /** export id (`hs-sn-000003-2`) → rendered <g> element */
  byExportId: Map<string, Element>;
  /** canonical id (`sn-000003`) → all rendered fragments */
  byCanonical: Map<string, Element[]>;
  noteCount: number;
}

export const SELECTED_CLASS = 'hs-selected';
export const ACTIVE_CLASS = 'hs-active';
export const HIT_CLASS = 'hs-hit';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Append an invisible hit ellipse over each note/rest glyph.
 *
 * Finding (UI-003): Verovio paints noteheads as font glyphs, and a hollow
 * notehead (half/whole note) is *transparent in the middle* — a click at its
 * centre falls through to the <svg> background. Relying on glyph paint for
 * hit-testing is therefore unreliable; the production-safe pattern is an
 * explicit transparent overlay inside each id-bearing group.
 */
function addHitShape(el: Element): void {
  if (typeof (el as SVGGElement).getBBox !== 'function') return; // jsdom etc.
  try {
    const head = el.querySelector('.notehead') ?? el.querySelector('use') ?? el;
    const box = (head as SVGGElement).getBBox();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const pad = Math.max(box.width, box.height) * 0.35;
    const hit = document.createElementNS(SVG_NS, 'ellipse');
    hit.setAttribute('cx', String(box.x + box.width / 2));
    hit.setAttribute('cy', String(box.y + box.height / 2));
    hit.setAttribute('rx', String(box.width / 2 + pad));
    hit.setAttribute('ry', String(box.height / 2 + pad));
    hit.setAttribute('class', HIT_CLASS);
    // Append inside the notehead group so the ellipse shares the glyph's
    // coordinate space; closest('[id^=hs-]') still resolves the note group.
    head.appendChild(hit);
  } catch {
    /* getBBox unsupported — skip hit shape (non-browser env) */
  }
}

/** Index every Verovio element carrying a HornScribe export id. */
export function buildElementIndex(container: Element): ElementIndex {
  const byExportId = new Map<string, Element>();
  const byCanonical = new Map<string, Element[]>();
  let noteCount = 0;
  for (const el of Array.from(container.querySelectorAll('[id^="hs-"]'))) {
    const id = el.id;
    if (!isMusicxmlNoteId(id) && !id.startsWith('hs-rest-')) continue;
    byExportId.set(id, el);
    addHitShape(el);
    const canonical = canonicalNoteIdFromMusicxml(id);
    if (canonical) {
      noteCount++;
      const list = byCanonical.get(canonical) ?? [];
      list.push(el);
      byCanonical.set(canonical, list);
    }
  }
  return { byExportId, byCanonical, noteCount };
}

/** Hit-test a click target up to the note/rest group carrying the id. */
export function resolveHitElement(target: EventTarget | null, container: Element): Element | null {
  if (!(target instanceof Element)) return null;
  const hit = target.closest('[id^="hs-"]');
  return hit && container.contains(hit) ? hit : null;
}

function setClass(elements: Iterable<Element>, cls: string, on: boolean): number {
  let n = 0;
  for (const el of elements) {
    el.classList.toggle(cls, on);
    n++;
  }
  return n;
}

/** Clear then apply `cls` to every rendered fragment of `canonicalId`. */
export function markCanonical(
  index: ElementIndex,
  canonicalId: string | null,
  cls: string,
): number {
  for (const el of Array.from(index.byExportId.values())) el.classList.remove(cls);
  if (!canonicalId) return 0;
  return setClass(index.byCanonical.get(canonicalId) ?? [], cls, true);
}

/** Apply `cls` to a set of canonical ids without clearing the selection class. */
export function markCanonicalSet(
  index: ElementIndex,
  canonicalIds: ReadonlySet<string>,
  cls: string,
): number {
  for (const el of Array.from(index.byExportId.values())) el.classList.remove(cls);
  let n = 0;
  for (const id of canonicalIds) n += setClass(index.byCanonical.get(id) ?? [], cls, true);
  return n;
}
