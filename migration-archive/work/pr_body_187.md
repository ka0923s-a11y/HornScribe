## Summary
Implements #187 as an opt-in vocal-isolation preprocessing stage — the free, librosa-only middle ground the issue names: **center-channel extraction** (demucs stays the documented eventual upgrade; ~200 MB of torch+weights does not fit the default engine install).

- `transcription/vocal.py`: `isolate_center_vocals` decodes stereo at 22050 Hz and applies a soft spectral mask `(mid - side) / (mid + side)` — center-panned lead vocals survive, wide-panned accompaniment is attenuated. `vocal_wav` memoizes per (contentHash, selection span) in a temp-dir cache (tmp+rename write) so re-transcription never re-runs the STFT; a cache-write failure falls back to a per-job temp file.
- `options.py`: `vocalIsolation` param (opt-in, default off), echoed in `settings_dict` so provenance and project restores carry it.
- `pipeline.py`: when on, the backend runs on the isolated WAV (selection staging is skipped — the isolated file already covers the span); event times still shift for selections. Provenance is never silent: `vocal_isolation_applied` (info) or `vocal_isolation_unavailable` with `mono_source`/`unavailable` detail (caution) lands as a review issue. Two new `ReviewReason` codes with ja copy in `ja.ts` + `ja-JP.json`.
- UI: 採譜オプション popover gains a ボーカル分離を使う checkbox with a hint that it is an estimate, not a true stem.

## Test plan
- `pytest tests/python -q`: 818 passed, 3 skipped (librosa is an engine extra — absent in dev/CI; the audio-path tests importorskip individually, the options contract still runs).
- New: spectral test (440 Hz center survives / 220 Hz side suppressed >5x), mono→None, cache-hit identity, option parse/echo, pipeline staging + fallback + review-issue tests.
- `ruff`/`mypy` clean; `tsc`/`eslint` clean; `vitest` 539 passed (new param-mapping tests).

Closes #187
