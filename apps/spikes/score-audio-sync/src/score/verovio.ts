/**
 * Thin wrapper around the Verovio WASM toolkit used by the spike.
 *
 * `verovio/wasm` inlines the WASM binary inside `dist/verovio-module.mjs`, so
 * module instantiation needs no network fetch and no .wasm asset pipeline —
 * that property is what keeps the spike (and later the Tauri shell) fully
 * offline without CSP workarounds beyond the script bundle itself.
 */
import createVerovioModule, { type VerovioModule } from 'verovio/wasm';
import {
  VerovioToolkit,
  type VerovioElementsAtTime,
  type VerovioTimemapEntry,
  type VerovioTimesForElement,
} from 'verovio/esm';

export interface RenderedPage {
  page: number;
  svg: string;
}

/** Spike instrumentation: total renderToSVG calls since module load. The
 *  playback/highlight path must never increment this (UI-005 criterion). */
export const renderStats = { renderToSVGCalls: 0 };

/** Baseline engraving options. `pageHeight` is short on purpose so the
 *  multi-system fixture paginates and `getPageWithElement` is exercised. */
const BASE_OPTIONS = {
  pageWidth: 2100,
  pageHeight: 1100,
  scale: 40,
  adjustPageHeight: false,
  footer: 'none',
  breaks: 'auto',
} as const;

export class ScoreRenderer {
  private toolkit: VerovioToolkit | null = null;
  private zoomPct = 100;

  get version(): string {
    return this.toolkit?.getVersion() ?? 'unknown';
  }

  async init(): Promise<void> {
    if (this.toolkit) return;
    const mod: VerovioModule = await createVerovioModule();
    this.toolkit = new VerovioToolkit(mod);
    this.toolkit.setOptions({ ...BASE_OPTIONS });
  }

  private tk(): VerovioToolkit {
    if (!this.toolkit) throw new Error('ScoreRenderer not initialized');
    return this.toolkit;
  }

  /** Returns true when Verovio accepted the document. */
  load(musicXml: string): boolean {
    return this.tk().loadData(musicXml);
  }

  setZoom(pct: number): void {
    this.zoomPct = pct;
    this.tk().setOptions({
      ...BASE_OPTIONS,
      // Verovio `scale` is a percent-like zoom factor (default 40). Pagination
      // is stable across scale changes because page size scales with it.
      scale: Math.max(10, Math.round((40 * pct) / 100)),
    });
  }

  getZoom(): number {
    return this.zoomPct;
  }

  pageCount(): number {
    return this.tk().getPageCount();
  }

  /** Render every page; page index is 1-based like `renderToSVG`.
   *  Page 1 is rendered first so the layout (and therefore `getPageCount`)
   *  reflects the current options before counting. */
  renderAllPages(): RenderedPage[] {
    const tk = this.tk();
    const first = tk.renderToSVG(1);
    renderStats.renderToSVGCalls += 1;
    const count = tk.getPageCount();
    const pages: RenderedPage[] = [{ page: 1, svg: first }];
    for (let page = 2; page <= count; page++) {
      pages.push({ page, svg: tk.renderToSVG(page) });
      renderStats.renderToSVGCalls += 1;
    }
    return pages;
  }

  /** Parsed timemap; must be (re)built after each `load`.
   *  verovio >= 4.x returns an already-parsed array (the ESM wrapper
   *  JSON.parses internally); older builds returned a raw string — accept both. */
  timemap(): VerovioTimemapEntry[] {
    const raw = this.tk().renderToTimemap() as unknown;
    if (typeof raw === 'string') return JSON.parse(raw) as VerovioTimemapEntry[];
    return raw as VerovioTimemapEntry[];
  }

  durationMs(): number {
    const map = this.timemap();
    let max = 0;
    for (const entry of map) max = Math.max(max, entry.tstamp);
    return max;
  }

  /** ms onset for an element id (e.g. `hs-sn-000003-2`), or null if unknown. */
  timeForElement(id: string): number | null {
    try {
      const t = this.tk().getTimeForElement(id);
      return Number.isFinite(t) && t >= 0 ? t : null;
    } catch {
      return null;
    }
  }

  timesForElement(id: string): VerovioTimesForElement | null {
    try {
      return this.tk().getTimesForElement(id);
    } catch {
      return null;
    }
  }

  elementsAtTime(ms: number): VerovioElementsAtTime | null {
    try {
      return this.tk().getElementsAtTime(ms);
    } catch {
      return null;
    }
  }

  /** 1-based page containing the element, 0 when not found. */
  pageWithElement(id: string): number {
    try {
      return this.tk().getPageWithElement(id);
    } catch {
      return 0;
    }
  }
}

/** Lazy singleton — survives React StrictMode double-mount and hot reloads. */
let rendererPromise: Promise<ScoreRenderer> | null = null;
export function getScoreRenderer(): Promise<ScoreRenderer> {
  if (!rendererPromise) {
    const renderer = new ScoreRenderer();
    rendererPromise = renderer.init().then(() => renderer);
  }
  return rendererPromise;
}
