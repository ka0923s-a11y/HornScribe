/** Type shim so tsc can check vite.config.ts's import of the .mjs plugin. */
import type { Plugin } from "vite";

export declare function devEngineBridge(): Plugin;
