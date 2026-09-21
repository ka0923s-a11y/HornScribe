/**
 * Focus zones — the major regions F6 cycles through (GUI_UX_SPEC §22).
 *
 * Regions self-identify with `data-hs-focus-zone="<id>"` on their root
 * element. The cycling order is the spec's Tab order:
 *
 *   コマンドバー → 波形 → 楽譜 → プロパティ → トランスポート → 状態領域
 *
 * Zones not in this list (e.g. the auxiliary 設定 screen) sort after it in
 * document order so F6 remains sensible on non-workspace screens.
 */

export const FOCUS_ZONE_ORDER = [
  "commandbar",
  "waveform",
  "score",
  "properties",
  "transport",
  "status",
] as const;

export type FocusZoneId = (typeof FOCUS_ZONE_ORDER)[number];

const ZONE_SELECTOR = "[data-hs-focus-zone]";

/**
 * Elements considered as a zone's landing target. The zone root itself is
 * the fallback (regions carry tabIndex so F6 has somewhere to land even
 * when they have no inner controls yet).
 */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[role="button"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isVisible(el: Element): boolean {
  // Explicit markers first — reliable in every DOM including jsdom.
  if (el.closest("[hidden], [aria-hidden='true'], [inert]") !== null) {
    return false;
  }
  // Stylesheet-driven hiding (the properties panel collapses below 1200px
  // via media query) needs computed style; in environments without layout
  // this returns the author/inline rules it knows, which is still correct
  // for anything we mark hidden in tests.
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (
    style &&
    (style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse")
  ) {
    return false;
  }
  return true;
}

/** All present, visible zone elements in cycling order. */
export function zoneElements(root: ParentNode = document): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(ZONE_SELECTOR)].filter(
    isVisible,
  );
  return found.sort((a, b) => {
    const ai = FOCUS_ZONE_ORDER.indexOf(
      a.dataset.hsFocusZone as FocusZoneId,
    );
    const bi = FOCUS_ZONE_ORDER.indexOf(
      b.dataset.hsFocusZone as FocusZoneId,
    );
    // Unknown zones (settings screen…) come after the spec'd order.
    const ra = ai === -1 ? FOCUS_ZONE_ORDER.length : ai;
    const rb = bi === -1 ? FOCUS_ZONE_ORDER.length : bi;
    if (ra !== rb) return ra - rb;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
  });
}

/** The zone containing the currently focused element, if any. */
export function currentZone(
  doc: Document = document,
): HTMLElement | null {
  const active = doc.activeElement;
  if (!(active instanceof Element)) return null;
  return active.closest<HTMLElement>(ZONE_SELECTOR);
}

/** First focusable element inside a zone, else the zone itself. */
export function zoneFocusTarget(zone: HTMLElement): HTMLElement {
  const inner = [...zone.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].find(
    isVisible,
  );
  return inner ?? zone;
}

/**
 * Moves focus to a named zone (first focusable element inside, or the zone
 * root). Returns true when focus moved.
 */
export function focusZone(
  id: string,
  root: ParentNode = document,
): boolean {
  const zone = zoneElements(root).find(
    (el) => el.dataset.hsFocusZone === id,
  );
  if (!zone) return false;
  const target = zoneFocusTarget(zone);
  target.focus();
  return true;
}

/**
 * F6 cycling: moves focus to the next (or previous, Shift+F6) major region.
 * Returns the id of the zone that received focus, or null when no zone was
 * available. When focus is not currently inside any zone, cycling starts
 * from the first zone in the spec order.
 */
export function cycleFocusZone(
  direction: 1 | -1,
  root: ParentNode = document,
): string | null {
  const zones = zoneElements(root);
  if (zones.length === 0) return null;
  const doc =
    root instanceof Document
      ? root
      : ((root as Node).ownerDocument ?? document);
  const current = currentZone(doc);
  const index = current ? zones.indexOf(current) : -1;
  const next =
    index === -1
      ? direction === 1
        ? zones[0]
        : zones[zones.length - 1]
      : zones[(index + direction + zones.length) % zones.length];
  zoneFocusTarget(next).focus();
  return next.dataset.hsFocusZone ?? null;
}
