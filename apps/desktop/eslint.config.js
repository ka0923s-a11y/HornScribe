import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // "_" prefixes mark throwaway scratch/verification files (never
    // committed) — linting them is noise and broke the release gate.
    ignores: ["dist", "src-tauri", "node_modules", "**/_*"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // UI-070 gate scripts run in Node and inject code into a real browser
    // page, so both Node and browser globals are legitimate there.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
