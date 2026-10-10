## Summary

Closes #367.

A SOURCE_MISSING project open restores the saved score for viewing +
editing (#219) — but the relink-success path re-fired
`onProjectScoreReady` with the file's saved extras, rebuilding the
ScoreDocument and silently discarding unsaved edits, review decisions,
and the undo stack. A hash-mismatch retry re-entered
`enterSourceMissing`, which fired the same restore a second time.

### Changes

- `finishRelink` attaches **audio only**. The live ScoreDocument stays;
  the verified new source path becomes the summary's `sourcePath` and
  flows to the host through a new `onProjectRelinked` event.
- `enterSourceMissing` gained a `restoreScore` flag — initial opens
  restore the saved score; relink retries (hash mismatch / unreadable
  candidate) re-enter the card without touching the document.
- `App` handles `onProjectRelinked` by updating the recorded
  `projectSourceRef` to the new path and dropping the clean baseline
  (`savedEditVersionRef = null`) — the source move is a real unsaved
  change: Ctrl+S writes it (the save serializes the relinked audio
  ref's path) and closing without saving now hits the 未保存 guard
  instead of landing on SOURCE_MISSING again next launch.
- `updateSourceRef` persists the relinked path to the recordings-prune
  index immediately so retention protection tracks what the session
  actually uses.

### Acceptance coverage

- score edits / review decisions / undo survive a relink — no second
  `scoreResult` event (integration test)
- failed relink retries no longer clobber the live score either
- new source path reaches the host + the index; next save persists it
- cancel/mismatch leaves state untouched (existing tests)

42 vitest / tsc / eslint green.