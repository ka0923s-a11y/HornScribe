## Summary

Four review fixes bundled on `codex/issue-fixes-299-301`:

- **#299** vocal-isolation cache was unbounded — `_sweep_cache` now drops entries older than 7 days (best-effort, never fatal).
- **#300** the dirty indicator was only an asterisk in the title bar — StatusBar now carries an `unsaved` badge with `--hs-status-warning-subtle` styling.
- **#301** `beforeunload` is unreliable in Tauri — replaced with `onCloseRequested` (dirty → save/discard/cancel dialog; recording → confirm dialog). `beforeunload` remains for browser dev only.
- **#302** evaluated demucs for vocal isolation and integrated it as an **opt-in** `engine-vocal` extra: `isolate_demucs_vocals` runs `python -m demucs --two-stems=vocals` in a subprocess, slices to the selection span, and falls back to center extraction on any failure. Cache keys now include the method so a demucs failure never pins a weaker stem under the demucs key. Pipeline evidence reports the actual method (`demucs` vs `center_extraction`).

Also fixed: `selection_start_sec` no longer leaks into vocal isolation when `range=all`.

## Verification

- `pytest tests/python -q` — 820 passed, 3 skipped (librosa engine extra absent in dev venv, expected)
- `vitest run` — 541 passed
- `tsc --noEmit`, `eslint`, `ruff`, `mypy` — clean

Closes #299, closes #300, closes #301, closes #302.
