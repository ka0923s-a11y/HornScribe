## Summary

Closes the meter half of #129 (§14 undo targets). setMeter joins the score.edit family:

- **Engine** (scoreedit.py): setMeter re-tiles every part under the new time signature through the same SpanRealizer path the other rhythm edits use. The subtlety: the canonical beat axis is defined by the *first* signature's beat unit, so changing 4/4 to 6/8 rescales every beat position by old_beat_ql / new_beat_ql — absolute durations are preserved. The tempo map, pickup span and rest spans rescale with the notes; committed atoms are cleared before re-tiling so scaled spans don't violate the atoms-tile-duration invariant. Mid-piece meter changes are collapsed (the edit sets the whole piece's meter). beatsPerMeasure is validated 1-64, beatUnit must be a power of two.
- **Desktop**: the score summary's meter row becomes an HsSelect of common signatures (2/4, 3/4, 4/4, 5/4, 6/8, 9/8, 12/8, 2/2, 3/8, 7/8); an unusual current meter stays selectable so the field never snaps the score to a preset. Commits through the same serialized rhythmQueue + commitDocSwap undo stack.
- inspector gains meterBeats/meterUnit parsed from the "n/m" meta label (parseMeterLabel).

## Tests

- test_scoreedit.py +7: same-unit re-tile, unit-change rescaling (quarter = 2 eighth-beats), tempo-map/pickup rescale, meter-changes collapse, rest re-tiling, missing-field and invalid-meter rejection.
- Verified: pytest 571, ruff, mypy; tsc, eslint; vitest 396.
