## Summary
- Fixes #229: selection transcription used to run Basic Pitch/pYIN and the tempo/meter analysis over the entire file, then clip the detected events. The decoded audio is now sliced at the selection bounds first and staged as a temp PCM16 WAV for the path-based backend — a 30 s selection of a 10 min source only ever processes 30 s.
- Backend events come back slice-relative, so they are shifted by selection_offset_sec back to absolute source seconds: clip_to_range, review seek targets, and project provenance keep the original timeline.
- The beat track runs on the slice and is shifted to absolute time. When a pinned meter + auto tempo + selection would otherwise let estimate_tempo track internally on the slice (mixing relative beat anchors with absolute event times), the track is pre-computed and shifted instead.
- Edge cases: empty/out-of-range selection fails fast with NO_PITCHED_CONTENT; a staging failure falls back to the original file (correct, just slower); the temp WAV is always removed after the blocking inference call.

## Tests
- tests/python/test_transcription.py::TestSelectionStaging — staged-path slice (frames counted inside the backend prove only the range was written), absolute re-anchoring of events, staging-failure fallback, out-of-range selection, and bend-time shifting.
- Full suite: 799 passed; ruff + mypy clean.

