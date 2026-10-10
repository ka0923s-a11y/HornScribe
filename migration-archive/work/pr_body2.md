## Summary

Accuracy pass on the real transcription pipeline (refs #84): auto meter estimation, octave-flicker repair, and downbeat anchoring fixes.

### Auto meter estimation (`transcription/meter.py`)
- Onset strength sampled at each tracked beat scores 2/4, 3/4, 4/4 by measure-start accent ratio (best phase wins).
- 6/8 requires a lag-6 accent *and* a secondary lag-3 accent on an eighth-note pulse; tracked anchors then bind eighths instead of dotted quarters.
- Weak or flat evidence falls back to 4/4 and emits a `meter_conflict` review issue (UI copy already existed) instead of guessing silently. `meta` reports `meter`, `meterEstimated`, `meterConfidence`.

### Downbeat anchoring (`tempo.py`)
- The beat tracker commonly drops the very first beat or lands a fraction of a pulse late. The warp now synthesizes the missed first beat / snaps a late beat 0 onto the first onset — real downbeats no longer misread as pickups. Waltz E2E: `pickupBeats` 1 → 0.
- BPM is now reported in primary-beat units for auto-6/8 (previously the tempo map would have run 3x fast in the MIDI export).

### Octave-flicker repair (`clean.py`)
- Isolated notes exactly ±12 semitones off *both* neighbours' shared pitch class snap to the neighbour octave (the classic Basic Pitch artifact on horn lines). Real octave leaps are untouched — neighbour agreement is required. Counted in `meta.cleaning.octaveCorrected`.

### Plumbing
- `ReviewReason.METER_CONFLICT` added (stable API addition; `meter_conflict` copy already in the UI deck).
- `_track_beats` shares one beat track between meter estimation and the tempo warp (no double tracking).

## Verification
- `pytest tests/python`: 518 passed (new tests: meter 2/4·3/4·4/4·6/8, uncertain fallbacks, octave repair vs. real leaps, A-minor cadence)
- `ruff` + `mypy --strict`: clean
- Real-engine E2E (subprocess worker, basic_pitch):
  - C-major scale @120 pinned: 8 notes, C major (0.795), meter_conflict flagged honestly
  - 3/4 waltz synth: meter 3/4, tempo 117.45 auto, C major (0.911), pickup 0
  - 6/8 synth: honest 4/4 fallback + meter_conflict when the tracker holds the dotted-quarter level

Refs #84 — the remaining gap (richer accent features, more meters, tracker-level disambiguation for compound meters) is noted in the issue.
