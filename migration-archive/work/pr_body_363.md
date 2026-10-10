## Summary

- `withPathOverride` marked any non-empty 設定 → ツール path as `検出済み` — a typo'd MuseScore/FFmpeg path looked healthy until the export subprocess failed.
- New `probe_tool_path` Tauri command checks the path is a real file; a shared `resolveToolWithOverride` (diagnostics/toolProbe.ts) verifies overrides and reports `未検出` while keeping the offending path visible.
- `TauriExportPort.capabilities` and `ShellDiagnosticsPort.collect` both use it — the diagnostics sheet now also reports real `detect_tools` results instead of blanket `unknown`.
- The unverified merge remains only where no fs bridge exists (vite dev / mock port).

Closes #363

## Test plan

- [x] `npx tsc --noEmit` clean
- [x] `npx eslint` clean on touched files
- [x] vitest: diagnostics + export + registry + sidecar + errorRecovery — 93 tests green
- [x] new `toolProbe.test.ts` covers verified/bogus override + no-bridge fallback

🤖 Generated with Codex
