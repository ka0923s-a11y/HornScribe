## Summary

Real-machine verification (browser dev + dev engine bridge + the full engine venv) surfaced that a `kind:"file"` drop produced a score titled `staged-1790284231128-runtime-fixture` — the scratch path the dev bridge staged, not the user's file.

- `displayName` param added to the transcription wire contract (`options.py`): optional, stripped, capped at 255 chars, collapses to `None` on non-string/blank.
- Pipeline derives the score title from `displayName` when present, else the audio-path stem as before.
- `buildTranscriptionParams` sends `audio.fileName` as `displayName` for every ref kind.

## Verification

- `pytest tests/python/test_transcription.py` — 83 passed
- `vitest run src/import/transcriptionParams.test.ts` — 9 passed; `tsc --noEmit`, `ruff`, `mypy` clean
- **Real end-to-end**: vite dev + devEngineBridge + `.venv-bp312` (basic_pitch + librosa) — drop → audioReady → 採譜 → engine job → score renders titled `runtime-fixture` (was `staged-<ts>-...`), Horn in F view, review issues, dirty badge all live.

Closes #305.
