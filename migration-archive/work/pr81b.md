## Summary
- The #81 intent is the user-facing 診断情報 sheet (GUI_UX_SPEC §19), not only the error-dialog dump from PR #83. This wires the same `result.meta` values through the §19 surface.
- New `sidecar/resultMeta.ts`: `extractTimingCorrection()` + `TimingCorrection` — the single shared reader for `meta.alignmentShiftSec` / `meta.alignmentMeterResolved` (null when absent, non-finite, or zero).
- `DiagnosticsInfo.timingCorrection` + `DiagnosticsSessionView.timingCorrection`; `ShellDiagnosticsPort` passes the session view through; `MockDiagnosticsPort` reports a sample (`timingCorrection: null` option exercises the silent state).
- Sheet + copy-text render `タイミング補正: +12.4 ms`（`（拍節解消）` when meter-resolved）; row omitted entirely when no correction was applied — silent by design.
- `session.buildDiagnostics()` refactored to the shared extractor (same `timingCorrectionSec:` dump line).
- Copy deck sync: `diagnostics.timingCorrection` / `timingCorrectionResolved` added to ja.ts and ja-JP.json, plus the drifted `close` / `fields.demucs` keys the deck was missing.

## Tests
- format.test: resolved-tag rendering, silent-when-null, untagged negative shift; port.test: session pass-through + mock silent option.
- 842/842 vitest green; tsc + eslint clean.

Closes #81
