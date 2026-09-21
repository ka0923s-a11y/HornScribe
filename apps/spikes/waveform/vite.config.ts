import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Repo root (three levels up from apps/spikes/waveform) so the canonical
// copy deck at protocol/copy/ja-JP.json can be imported in dev mode.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    // Spike-only app: keep the bundle warning threshold honest but do not
    // tune chunking here; packaging decisions belong to the product app.
    chunkSizeWarningLimit: 900,
  },
})
