import { defineConfig } from 'vitest/config'

// Unit tests for the UI-independent sync/mapping layer. Tests that need
// DOMParser opt into jsdom via `// @vitest-environment jsdom` pragmas.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
