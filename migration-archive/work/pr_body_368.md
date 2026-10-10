## Summary

Closes #368.

`selectAdjacentNote` walked `docs.concert.notes` — the raw MusicXML
fragment list. A canonical note split by a barline or a complex
duration emits `hs-sn-000123`, `hs-sn-000123-2`, `hs-sn-000123-3`… all
sharing `canonicalId = sn-000123`. With duplicates in the array,
`indexOf(cur)` always lands on the first fragment, so ArrowRight kept
selecting the same note and the next canonical note was unreachable by
keyboard.

### Changes

- New `canonicalNoteOrder(doc)` in `scoreDoc.ts` — first occurrence
  wins, so tie fragments collapse to one step while chord members
  (distinct canonicalIds) keep their own entries; rests have no
  canonicalId and stay out, per current spec.
- `selectAdjacentNote` walks that order. Selection itself still lands
  on the first fragment's exportId, so clicking mid-tie and the
  Concert/F管 views behave identically in both page and continuous
  modes.

### Tests

- `scoreDoc.test.ts`: the existing barline-tie fixture asserts the
  collapsed order; a new fixture covers a 3-fragment tie chain plus a
  `<chord/>` member keeping its own canonical step.

14 vitest / tsc / eslint green.