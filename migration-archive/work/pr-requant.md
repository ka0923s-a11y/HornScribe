## Summary

Closes #130 (§14 undo target: quantization settings as a command). The finished score can now be re-quantized under changed settings without re-transcribing:

- **Engine** (scoreedit.py): new requantize edit kind. Each part's canonical notes replay through quantize_events as synthetic raw events on an identity warp (fixed 60 bpm, zero alignment shift), so the DP re-searches the grid under the merged profile — a coarser min-duration drops ornament-level onsets, a finer one splits, and triplet policy changes re-decide tuplet regions. Canonical ids are preserved positionally (score-order index matching); extra new notes continue the document's sn-* numbering, vanished ids drop with their notes. Settings overrides are validated — only minDurationQl / triplets / simplicity are accepted, unknown keys are rejected so a typo never looks applied.
- **Desktop**: new RequantizeDialog (overflow menu "採譜設定を変えて再適用") edits the three profile knobs, seeded from the payload's stored quantizationSettings. Apply routes through the same serialized rhythmQueue + commitDocSwap undo stack — Ctrl+Z restores the previous notation.

## Tests

- test_scoreedit.py +6: positional id preservation, settings merge, triplet-atom rewrite under triplets=none, source-id carry-over, empty/unknown/invalid settings rejection.
- Verified: pytest scoreedit 36/36, ruff, mypy; tsc, eslint; vitest 401/401.
