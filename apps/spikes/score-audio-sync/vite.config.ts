import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Repo root (three levels up from apps/spikes/score-audio-sync) so the
// canonical copy deck at protocol/copy/ja-JP.json and the committed ENG-001
// fixtures can be imported in dev mode. `vite build` bundles everything via
// ?raw / JSON imports, so the production artifact is fully self-contained.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    target: 'es2022',
    // The inlined-WASM verovio module is ~7 MB minified (same as UI-003).
    chunkSizeWarningLimit: 9000,
  },
})
