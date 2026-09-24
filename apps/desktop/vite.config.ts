import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devEngineBridge } from "./scripts/devEngineBridge.mjs";

// Tauri dev server convention: fixed port 1420.
// The webview loads this devUrl in dev mode; in production it serves
// the bundled `dist/` directory through the tauri:// custom protocol.
export default defineConfig({
  plugins: [react(), devEngineBridge()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust sources are not part of the frontend build.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
    // Tauri serves dist via a custom protocol; relative base keeps it portable.
    target: "es2022",
    sourcemap: false,
  },
});
