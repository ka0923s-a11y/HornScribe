/**
 * Minimal typings for the `verovio` npm package (v6.x ships no .d.ts).
 * Covers only the toolkit surface exercised by the UI-003 spike.
 * API reference: https://book.verovio.org/toolkit-reference/toolkit-methods.html
 */
declare module 'verovio/wasm' {
  /** Emscripten module hosting the Verovio WASM binary (inlined in the dist file). */
  export interface VerovioModule {
    readonly [key: string]: unknown;
  }
  export default function createVerovioModule(
    moduleArg?: Record<string, unknown>,
  ): Promise<VerovioModule>;
}

declare module 'verovio/esm' {
  import type { VerovioModule } from 'verovio/wasm';

  export interface VerovioElementsAtTime {
    notes: string[];
    chords: string[];
    rests: string[];
    measure?: string;
    page?: number;
  }

  export interface VerovioTimesForElement {
    tstampOn: number[];
    tstampOff: number[];
    qfracOn?: number[][];
    qfracOff?: number[][];
    qfracDuration?: number[][];
    qfracTiedDuration?: number[][];
  }

  export interface VerovioTimemapEntry {
    on?: string[];
    off?: string[];
    qstamp: number;
    tstamp: number;
    tempo?: number;
  }

  export class VerovioToolkit {
    constructor(module?: VerovioModule);
    setOptions(options: Record<string, unknown>): boolean;
    getOptions(defaultValues?: boolean): Record<string, unknown>;
    loadData(data: string): boolean;
    renderToSVG(page: number): string;
    getPageCount(): number;
    /** The ESM wrapper JSON.parses internally — returns the parsed array. */
    renderToTimemap(options?: Record<string, unknown>): VerovioTimemapEntry[];
    getElementsAtTime(milliseconds: number): VerovioElementsAtTime;
    getTimeForElement(xmlId: string): number;
    getTimesForElement(xmlId: string): VerovioTimesForElement;
    getPageWithElement(xmlId: string): number;
    getElementAttr(xmlId: string): Record<string, unknown>;
    getVersion(): string;
    destroy?(): void;
  }
}
