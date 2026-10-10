## Summary

Closes #131 (§13 post-MVP: note split / merge). Two new score.edit kinds:

- **splitNote** — halves the selected note at the grid-snapped midpoint (round-half-up on min_note_value_ql steps; a note with no interior grid point is rejected honestly). The second half gets a fresh sn-* id continuing the document's numbering. Ties redistribute: the first half keeps an incoming tie, the second keeps the outgoing one, and the halves are never tied to each other — a split is a visible separation.
- **mergeNotes** — collapses a contiguous same-pitch pair into ONE canonical note (vs tie-untie which keeps two written notes). The first id survives, source_event_ids union, the second id is freed. Validations mirror tie rules: same pitch, contiguous, next note exists.

The shared re-tile tail of _apply_timing_edit is extracted as _retile_part — timing, split and merge all splice through the same measure-window rebuild, so rest gaps and atom decomposition stay consistent.

Desktop: S (split) / M (merge) shortcuts + overflow menu items behind the same hasScore+selection gate; both route through the serialized rhythmQueue and share the undo stack.

## Tests

- test_scoreedit.py +8: midpoint split, too-short rejection, tie redistribution, merge (id/source union), different-pitch/non-contiguous/last-note rejection, split-merge roundtrip.
- Verified: pytest scoreedit 44/44; tsc, eslint clean.
