/**
 * Thin wrapper around the Verovio WASM toolkit (UI-030 production port of the
 * UI-003/UI-005 spike wrapper).
 *
 * `verovio/wasm` inlines the WASM binary inside `dist/verovio-module.mjs`, so
 * module instantiation needs no network fetch and no `.wasm` asset pipeline —
 * the whole score path ships inside the JS bundle and stays fully offline.
 * WebAssembly compilation requires `wasm-unsafe-eval` in the webview CSP
 * (src-tauri/tauri.conf.json); see docs/UI_003_SPIKE_RESULTS.md §9.
 */
import type { VerovioModule } from "verovio/wasm";
import {
  VerovioToolkit,
  type VerovioElementsAtTime,
  type VerovioTimemapEntry,
  type VerovioTimesForElement,
} from "verovio/esm";

export interface RenderedPage {
  page: number;
  svg: string;
}

/** Score display mode (GUI_UX_SPEC §10: 連続表示 is the default candidate;
 *  ページ表示 is the comparison mode the MVP keeps). */
export type ScoreViewMode = "continuous" | "page";

/** Instrumentation: total renderToSVG calls since module load. The playback /
 *  highlight path must never increment this (UI-005 criterion, kept so tests
 *  can assert no full SVG rerender happens on the frame path). */
export const renderStats = { renderToSVGCalls: 0 };

/**
 * Baseline engraving options. `adjustPageHeight` is switched per view mode:
 * continuous renders one tall page (all systems stacked — a true 連続表示
 * scroll), page mode paginates at an A4-ish height so ページ表示 is real.
 * Pagination is stable across `scale` (UI-003: page size scales with it).
 */
const BASE_OPTIONS = {
  pageWidth: 2100,
  scale: 40,
  footer: "none",
  breaks: "auto",
} as const;

const CONTINUOUS_OPTIONS = {
  ...BASE_OPTIONS,
  adjustPageHeight: true,
} as const;

const PAGE_OPTIONS = {
  ...BASE_OPTIONS,
  pageHeight: 2970,
  adjustPageHeight: false,
} as const;

/** Score zoom bounds (GUI_UX_SPEC §15: Ctrl+= / Ctrl+- / Ctrl+0). */
export const SCORE_ZOOM_MIN_PCT = 25;
export const SCORE_ZOOM_MAX_PCT = 200;
export const SCORE_ZOOM_STEP_PCT = 25;
export const SCORE_ZOOM_DEFAULT_PCT = 100;

export function clampScoreZoom(pct: number): number {
  return Math.min(SCORE_ZOOM_MAX_PCT, Math.max(SCORE_ZOOM_MIN_PCT, Math.round(pct)));
}

export class ScoreRenderer {
  private toolkit: VerovioToolkit | null = null;
  private zoomPct = SCORE_ZOOM_DEFAULT_PCT;
  private viewMode: ScoreViewMode = "continuous";

  get version(): string {
    return this.toolkit?.getVersion() ?? "unknown";
  }

  async init(): Promise<void> {
    if (this.toolkit) return;
    // Dynamic import: the ~8 MB inlined-WASM module becomes a lazily-fetched
    // bundle chunk instead of inflating first paint — still fully offline
    // since the bytes ship inside the app bundle (UI-003 constraint).
    const { default: createVerovioModule } = await import("verovio/wasm");
    const mod: VerovioModule = await createVerovioModule();
    this.toolkit = new VerovioToolkit(mod);
    this.toolkit.setOptions(this.options());
    // UI-070 gate hook: lets the scripted perf run assert zero renderToSVG
    // calls on the playback/highlight path (UI-005 criterion). Dev-only —
    // never populated in packaged builds.
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as unknown as { __hsRenderStats?: typeof renderStats })
        .__hsRenderStats = renderStats;
    }
  }

  private options(): Record<string, unknown> {
    const base = this.viewMode === "continuous" ? CONTINUOUS_OPTIONS : PAGE_OPTIONS;
    return {
      ...base,
      // Verovio `scale` is a percent-like zoom factor (default 40).
      scale: Math.max(10, Math.round((40 * this.zoomPct) / 100)),
    };
  }

  private tk(): VerovioToolkit {
    if (!this.toolkit) throw new Error("ScoreRenderer not initialized");
    return this.toolkit;
  }

  /** Returns true when Verovio accepted the document. NOTE (UI-003 finding):
   *  loadData also returns true for truncated-but-parseable XML — callers
   *  must verify rendered content, not just this flag. */
  load(musicXml: string): boolean {
    return this.tk().loadData(musicXml);
  }

  setZoom(pct: number): void {
    this.zoomPct = clampScoreZoom(pct);
    this.tk().setOptions(this.options());
  }

  getZoom(): number {
    return this.zoomPct;
  }

  setViewMode(mode: ScoreViewMode): void {
    this.viewMode = mode;
    this.tk().setOptions(this.options());
  }

  getViewMode(): ScoreViewMode {
    return this.viewMode;
  }

  pageCount(): number {
    return this.tk().getPageCount();
  }

  /** Render one page (1-based). #247: page mode renders only the
   *  visible page — a long score's untouched pages never hit
   *  renderToSVG on load, zoom, or the Concert↔F管 switch. */
  renderPage(page: number): string {
    const svg = this.tk().renderToSVG(page);
    renderStats.renderToSVGCalls += 1;
    return svg;
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
    if (typeof raw === "string") return JSON.parse(raw) as VerovioTimemapEntry[];
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
    /* #401: a rejected init must not poison the singleton — drop the
     * cached promise so the error surface's 再試行 gets a fresh init
     * attempt instead of replaying the same rejection forever. */
    rendererPromise.catch(() => {
      rendererPromise = null;
    });
  }
  return rendererPromise;
}
