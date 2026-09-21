import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// UI-003 spike. Verovio ships its WASM inline in dist/verovio-module.mjs, so no
// .wasm asset pipeline or CDN is required — everything bundles offline.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // `vite dev` must be able to read the committed ENG-001 fixtures and the
      // canonical ja-JP copy deck from the repository root. `vite build` already
      // bundles them via ?raw / JSON imports, so the production artifact is
      // self-contained either way.
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../../', import.meta.url)),
      ],
    },
  },
  build: {
    target: 'es2022',
    // The inlined-WASM verovio module is ~7 MB minified; that is expected and is
    // reported in docs/UI_003_SPIKE_RESULTS.md.
    chunkSizeWarningLimit: 9000,
  },
});
