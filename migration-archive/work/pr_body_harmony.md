## Summary

Closes #44 - the #3 chord map now reaches MusicXML as `<harmony>` symbols.

**Plumbing**: the chord map rides on `ScoreDocument` as a new `chord_symbols` field (`ChordSymbol`, beat-addressed, concert space) - document-level analysis metadata like `raw_evidence`, outside the payload so it never churns the content-derived score revision and survives `score.edit` round-trips verbatim (the TS side treats the doc as opaque).

**Export**: `_insert_harmony_symbols` runs during MusicXML normalization and emits `<harmony><root/><kind/></harmony>` on the first (top) part only.

Design decisions, per the issue:

- **Transposed parts**: `horn_in_f.musicxml` carries written-pitch symbols (root +P5, respelled under the same flat/sharp policy) so a symbol names the harmony in the key the player reads - matching real transposed-part convention.
- **Mid-measure placement**: anchors are non-chord `<note>`/`<direction>`/`<barline>` children tracked on the divisions cursor (backup/forward aware); an unanchored onset lands on the next anchor with a negative `<offset>` back to its true position.
- **Low-confidence handling**: symbols under the `chord_uncertain` floor (conf < 0.35 or margin < 0.04) are not baked into notation. A filtered segment also breaks a same-chord run so the resuming chord restates instead of silently extending.
- **JPOP spelling preserved**: `kind@text` carries the estimator's own spelling (`m7-5`, `maj7`) so readers don't substitute `ø`/`△` glyphs.

**Docs**: `MUSESCORE_ROUNDTRIP.md` moves `<harmony>` out of the not-exported list (it is now a verification target); `PRODUCT_BOUNDARY.md` records the code-name boundary - export-only, no in-app display or editing.

## Test plan

- 14 new tests in `tests/python/test_musicxml_harmony.py`: emission, kind/text mapping, flat/sharp spelling, mid-measure `<offset>`, confidence gating, contiguous-run merge + gap restate, horn transposition + accidental respelling, first-part-only placement, document round-trip, revision stability, determinism.
- Full python suite: 996 passed, 3 skipped; ruff clean.
- Real-machine check (.venv-bp312, `e2e_scale.wav`): 4 chord segments on the document, the contested-margin one correctly filtered -> 3 `<harmony>` in both exports; music21 re-parses them (C/G7/Am7/B half-dim; transposed G/D7/Em7/F# half-dim).

Ref #44, #3, #15
