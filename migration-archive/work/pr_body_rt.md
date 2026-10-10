Addresses #15 (partially — see Status).

## What

MusicXML round-trip verification. The verification host has no MuseScore install, so the automated tier uses music21's MusicXML importer — the same partwise 4.0 grammar MuseScore consumes — and proves the exported score parses back with **no lost or reshaped elements**.

### Automated tier (`tests/python/test_musicxml_roundtrip.py`, 11 cases)

- Content: measure count, notes, rests (incl. summed rest durations), tied barline fragments (`start`/`stop` ties, total span preserved), canonical `sn-*` note ids, chord members, accidental spelling (flat key → Eb not D#, sharp key → C#).
- Structure: mid-score key change lands on the right measure, tempo changes survive as metronome marks, the swing marking keeps both the visible "Swing" text and the `<sound><swing>` playback hint, multi-part scores keep both parts, the F-horn export transposes back to sounding pitch while showing written pitch.
- Broad sweep: range extremes, deep-flat minor keys, pickups — every shape must at least parse cleanly.

### Manual tier (`docs/MUSESCORE_ROUNDTRIP.md`)

- What the automated tier already guarantees (no need to re-check by hand).
- A MuseScore GUI checklist: import both concert + horn exports, verify notes/rests/ties/chords, barlines, mid-score key/tempo changes, accidentals, the Swing marking, transposition, and absence of import warnings.
- Known non-targets: chord symbols (`<harmony>` — not yet emitted; `chordProgression` from #41 is the future input) and expression markings.
- Recording rule: manual runs get logged on #15 with MuseScore version + score + result.

## Status vs the issue

- [x] Representative scores verified against an importer (music21 tier).
- [x] Verification procedure documented.
- [ ] A real MuseScore GUI pass — needs a host with MuseScore installed; the checklist in the doc is exactly what to run and where to log it.

## Verification

- pytest: new file 11/11, musicxml sweep 143/143, full suite green.

## Notes

- No exporter changes needed — the round-trip tier validates the CURRENT output rather than patching it, and every element class checked in the issue (swing, accidentals, multi-voice, tempo changes) round-trips.
