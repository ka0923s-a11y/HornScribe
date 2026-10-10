## Summary

Closes #370.

The completed-gate verified only `musicxml_concert` — the F管 file is
the product's main artifact (#257 showed a real concert-key +7 →
written +8 corruption class), yet its transposition, key signature,
pitch and structure shipped unverified.

### Changes

- New `verify_horn_f_projection(score, xml)` in `export/musicxml.py`:
  1. **transpose block** — the part must declare Horn in F
     `diatonic=-4 / chromatic=-7` (missing/wrong → written reads as
     sounding a fifth too high).
  2. **per-note sounding projection** — `written + chromatic` must
     equal the canonical `pitch_midi` for every canonical id, catching
     semitone slips, dropped octaves and respelled-to-wrong-pitch
     corruption that the rhythm check cannot see.
  3. **key signatures** — every measure's effective key must equal
     `horn_f.written_key_signature(concert key)` (+1 fifth, folded),
     the same projection policy the note spelling used.
- The pipeline now also runs `verify_rhythm_roundtrip` on
  `musicxml_horn` per part — measure count, spans, ties, canonical-id
  coverage on the F管 file itself.
- All findings flow into the same `STRUCTURAL_MEASURE_CONFLICT`
  evidence list with `hornF part N:` prefixes; unparseable output
  still fails the export the same way a broken concert file does.

### Tests

- Parametrized clean-run over all rhythm fixtures (concert + horn).
- Key projection across `(0, -2, +3 minor, +7)` — including the #257
  C#→Ab enharmonic fold.
- Corruption cases: semitone-shifted written pitch, `chromatic` zeroed
  out, key fifths mismatched.

93 vitest-equivalent pytest / ruff / mypy green.