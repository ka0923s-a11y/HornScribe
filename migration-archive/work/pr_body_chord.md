Closes #3

## What

Local chord-map estimation (orig #419) — harmony context for the pipeline, computed entirely offline: CQT chroma averaged inside half-measure segments, matched against a 9-quality chord-template set (cosine similarity), then smoothed by a Viterbi pass whose switch cost follows circle-of-fifths distance and whose emissions get a small diatonic bonus from the already-estimated key. No model weights, no external service — the free-operation constraint holds.

### Engine (`transcription/chord.py`)

- 108 (root, quality) template states: maj, min, 7, maj7, m7, m7b5, dim, aug, sus4, with JPOP-faithful labels (`Bm7-5`).
- Viterbi smoothing: same-chord self-loop is free, same-root quality changes cost half, root changes scale by fifths distance — a hairline flicker to F and back stays on C, a real IV move still switches.
- Key prior: `diatonic_chords(fifths, mode)` gives diatonic candidates a +0.03 emission bonus (relative-minor tonic handled correctly — the fifths signature names the major, tonic sits +9 semitones).
- Segments snap to the canonical beat grid at half-measure granularity — where JPOP harmonic rhythm actually lives — mapped to seconds through the tempo warp.
- Enhancement-layer discipline: any failure leaves an empty map instead of sinking the job.

### Uses

- **`chord_uncertain` review issue** — a segment flags when the best template explains the chroma weakly (`confidence < 0.35`) or two candidates nearly tie (`margin < 0.04`); segments without note onsets are skipped since an interlude carries no spelling/rhythm decisions. Evidence names the suggested chord, runner-up, confidence and margin. INFO severity, capped at 10, no auto-fix — the map informs judgment, it does not silently correct.
- **`pitch_spelling_ambiguous` evidence** gains `localChord` + `chordTone` — the reviewer can see whether a chromatic tone is a chord tone (secondary dominant, blues) or a passing artifact.
- **Result meta** gains `chordProgression` — merged same-chord spans with labels, ready for a future chord-track UI or MusicXML `<harmony>` export.

### UI

- `chord_uncertain` reason wired through the sidecar deck, the score union, `ja.reviewReasons`, the JSON copy deck, and an evidence formatter naming the suggested chord, runner-up, and confidence/margin percentages.

## Tests

- `test_chord.py` (14): labels/suffixes, chord tones, diatonic degrees for major and minor, clean I–V estimation, switch-cost stickiness vs. real switches, flat-key spelling, every uncertainty gate, the noteless-segment skip, and merged serialization. `_segment_chroma` is monkeypatched so the estimator logic runs without librosa.
- `test_review.py` enum contract extended.

## Verification

- pytest tests/python: 971 passed, 3 skipped
- vitest 780/780, tsc --noEmit clean, eslint clean, ruff clean

## Follow-ups (filed as issues separately if wanted)

- MusicXML `<harmony>` chord-symbol export of `chordProgression`.
- Chord-tone-aware spelling bias in the notation layer (deeper: `spell_midi` currently sees only fifths).
