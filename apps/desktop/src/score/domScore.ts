/**
 * DOM-side helpers for the rendered Verovio SVG (UI-030 production port of
 * the UI-003/UI-005 spike helpers).
 *
 * Verovio mirrors the MusicXML `note/@id` onto the rendered element
 * (`<g class="note" id="hs-sn-000003">`), so a rendered element can be looked
 * up by export id and resolved to a canonical `sn-*` id. Highlighting is a
 * pure `classList` toggle — no re-render (measured: ~0.01 ms/element, see
 * docs/UI_003_SPIKE_RESULTS.md §3).
 */
import { canonicalNoteIdFromMusicxml, isMusicxmlNoteId } from "./ids";

export interface ElementIndex {
  /** export id (`hs-sn-000003-2`) → rendered <g> element */
  byExportId: Map<string, Element>;
  /** canonical id (`sn-000003`) → all rendered fragments */
  byCanonical: Map<string, Element[]>;
  noteCount: number;
}

export const SELECTED_CLASS = "hs-selected";
export const ACTIVE_CLASS = "hs-active";
export const HIT_CLASS = "hs-hit";
/** Loop-passage indication: applied to every rendered fragment of canonical
 *  notes whose span overlaps the armed A-B loop. */
export const LOOP_CLASS = "hs-loop";
/** Subtle wash on the measure <g> containing an active note. */
export const MEASURE_ACTIVE_CLASS = "hs-measure-active";
/** Review-marker group appended to notes carrying an open 要確認 issue. */
export const REVIEW_MARK_CLASS = "hs-review-mark";
/** Playback caret inserted into the active measure group (§10 hierarchy). */
export const CARET_CLASS = "hs-score-caret";
const WASH_CLASS = "hs-measure-wash";

const SVG_NS = "http://www.w3.org/2000/svg";

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
  if (typeof (el as SVGGElement).getBBox !== "function") return; // jsdom etc.
  try {
    const head = el.querySelector(".notehead") ?? el.querySelector("use") ?? el;
    const box = (head as SVGGElement).getBBox();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const pad = Math.max(box.width, box.height) * 0.35;
    const hit = document.createElementNS(SVG_NS, "ellipse");
    hit.setAttribute("cx", String(box.x + box.width / 2));
    hit.setAttribute("cy", String(box.y + box.height / 2));
    hit.setAttribute("rx", String(box.width / 2 + pad));
    hit.setAttribute("ry", String(box.height / 2 + pad));
    hit.setAttribute("class", HIT_CLASS);
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
    if (!isMusicxmlNoteId(id) && !id.startsWith("hs-rest-")) continue;
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
export function resolveHitElement(
  target: EventTarget | null,
  container: Element,
): Element | null {
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

/**
 * The rendered measure group containing an element — Verovio wraps each
 * measure in `<g class="measure">` (random id). Used for the "current
 * measure" wash; the id itself is never treated as identity (UI-003 finding:
 * non-`hs-*` ids are unstable), the element is re-resolved every mark.
 */
export function measureElementOf(el: Element): Element | null {
  return el.closest("g.measure");
}

/**
 * Toggle `cls` on the measure groups containing the given elements, and (in
 * browsers, where getBBox exists) maintain a `<rect class="hs-measure-wash">`
 * background covering the measure's extent — the "current measure subtle
 * wash" of GUI_UX_SPEC §10 without touching any glyph.
 */
export function markMeasures(
  container: Element,
  elements: Iterable<Element>,
  cls: string,
  on: boolean,
): number {
  const measures = new Set<Element>();
  for (const el of elements) {
    const m = measureElementOf(el);
    if (m) measures.add(m);
  }
  let n = 0;
  for (const m of Array.from(container.querySelectorAll("g.measure"))) {
    const target = on && measures.has(m);
    if (m.classList.contains(cls) !== target) {
      m.classList.toggle(cls, target);
      let wash = m.querySelector(`:scope > rect.${WASH_CLASS}`);
      if (target && !wash && typeof (m as SVGGElement).getBBox === "function") {
        try {
          const box = (m as SVGGElement).getBBox();
          wash = document.createElementNS(SVG_NS, "rect");
          wash.setAttribute("x", String(box.x));
          wash.setAttribute("y", String(box.y));
          wash.setAttribute("width", String(box.width));
          wash.setAttribute("height", String(box.height));
          wash.setAttribute("class", WASH_CLASS);
          m.insertBefore(wash, m.firstChild);
        } catch {
          /* getBBox unsupported — class mark still applied */
        }
      } else if (!target && wash) {
        wash.remove();
      }
    }
    if (target) n++;
  }
  return n;
}

/**
 * Playback caret (§10 hierarchy: caret → measure wash → active note).
 * Draws a thin rect inside the given measure group at `x`, spanning the
 * measure's vertical extent. Inserted in SVG user units so it scales with
 * zoom and needs no client-rect math. Returns the caret element (or null
 * when the geometry cannot be measured, e.g. jsdom).
 */
export function drawCaret(measure: Element, x: number): Element | null {
  if (typeof (measure as SVGGElement).getBBox !== "function") return null;
  try {
    const box = (measure as SVGGElement).getBBox();
    if (box.height <= 0) return null;
    const caret = document.createElementNS(SVG_NS, "rect");
    caret.setAttribute("x", String(x - 1));
    caret.setAttribute("y", String(box.y));
    caret.setAttribute("width", "2");
    caret.setAttribute("height", String(box.height));
    caret.setAttribute("class", CARET_CLASS);
    measure.insertBefore(caret, measure.firstChild);
    return caret;
  } catch {
    return null;
  }
}

/** Remove any caret drawn inside `container` (called before re-drawing). */
export function clearCaret(container: Element): void {
  for (const el of Array.from(container.querySelectorAll(`rect.${CARET_CLASS}`))) {
    el.remove();
  }
}

/**
 * Draw 要確認 markers on the rendered fragments of the given canonical ids.
 *
 * Spec (GUI_UX_SPEC §12, §15): review markers are a warning-tint dotted cue
 * — never error red, never a strong fill. The marker is a dotted underline
 * under the note's bounding box plus a small "!" badge above-right; it is
 * appended inside the id-bearing note group so clicks still resolve to the
 * note and the cue inherits the score's coordinate space / zoom.
 *
 * Markers live in the (aria-hidden) SVG only as a visual cue; the readable
 * reason text is surfaced by the properties inspector (§24).
 */
export function markReviewMarkers(
  container: Element,
  index: ElementIndex,
  canonicalIds: ReadonlySet<string>,
): number {
  for (const el of Array.from(container.querySelectorAll(`g.${REVIEW_MARK_CLASS}`))) {
    el.remove();
  }
  let n = 0;
  if (typeof document.createElementNS !== "function") return 0;
  for (const canonicalId of canonicalIds) {
    // One marker per canonical note, on its first rendered fragment.
    const host = index.byCanonical.get(canonicalId)?.[0];
    if (!host || typeof (host as SVGGElement).getBBox !== "function") continue;
    try {
      const box = (host as SVGGElement).getBBox();
      if (box.width <= 0 || box.height <= 0) continue;
      const padX = Math.max(6, box.width * 0.2);
      const lineY = box.y + box.height + Math.max(8, box.height * 0.25);
      const mark = document.createElementNS(SVG_NS, "g");
      mark.setAttribute("class", REVIEW_MARK_CLASS);
      mark.setAttribute("aria-hidden", "true");

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(box.x - padX));
      line.setAttribute("x2", String(box.x + box.width + padX));
      line.setAttribute("y1", String(lineY));
      line.setAttribute("y2", String(lineY));
      line.setAttribute("class", `${REVIEW_MARK_CLASS}__line`);
      mark.appendChild(line);

      const r = Math.max(10, box.height * 0.3);
      const badge = document.createElementNS(SVG_NS, "circle");
      badge.setAttribute("cx", String(box.x + box.width + padX + r));
      badge.setAttribute("cy", String(box.y - r * 0.6));
      badge.setAttribute("r", String(r));
      badge.setAttribute("class", `${REVIEW_MARK_CLASS}__badge`);
      mark.appendChild(badge);

      const glyph = document.createElementNS(SVG_NS, "text");
      glyph.setAttribute("x", String(box.x + box.width + padX + r));
      glyph.setAttribute("y", String(box.y - r * 0.6 + r * 0.42));
      glyph.setAttribute("text-anchor", "middle");
      glyph.setAttribute("font-size", String(r * 1.3));
      glyph.setAttribute("class", `${REVIEW_MARK_CLASS}__glyph`);
      glyph.textContent = "!";
      mark.appendChild(glyph);

      host.appendChild(mark);
      n++;
    } catch {
      /* getBBox unsupported — skip this marker */
    }
  }
  return n;
}
