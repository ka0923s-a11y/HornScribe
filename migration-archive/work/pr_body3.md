## Summary

Two gaps from the deep-review issues: silent polyphony collapse (#85) and per-recording management (#78 remainder).

### Polyphony warning (refs #85)
- `clean.py` now counts `polyphonic_overlaps` — overlaps clipped by the monophonic rule where the two events have *different* pitch classes (same pitch class = octave ghost / re-detection, not a second voice).
- When the count is non-zero the pipeline emits an `overlapping_candidates` review issue with the count in evidence — the user is told a second voice may have been merged away instead of the score silently losing it.

### Per-recording delete (refs #78)
- `capture.rs`: `recordings_list` (name/bytes/mtime, sorted) and `delete_recording` (filename-only, rejects path separators/`..`, `CAPTURE_BUSY` while recording).
- `recordings.ts`: `listRecordings`/`deleteRecording` helpers.
- `SettingsView`: recordings pane now lists each WAV with its size and a per-file delete button behind a filename-confirming alert dialog; list refreshes after delete/clear.

## Verification
- `pytest tests/python`: 518 passed; `ruff` + `mypy --strict`: clean
- `tsc --noEmit`, `eslint`: clean; `vitest`: 322 passed
- Rust compiles in CI (`desktop` job).
