## Summary

Partial fix for #128 (§26 session restore). The score's zoom % and view mode now persist in the shared hornscribe.layout.v1 record and are restored on the next launch:

- PersistedLayout gains scoreZoomPct / scoreViewMode; new readScoreSessionView / writeScoreSessionView helpers read+merge the same blob, so panel sizes and view state never clobber each other.
- ScoreReadyWorkspace seeds zoom / viewMode (and their refs) from the persisted session view; the settings "初期表示" only applies when no session state exists — matching the two-layer model proposed in the issue (session wins, setting is the first-run default).
- changeZoom / changeViewMode persist on every change.

Remaining under #128: last-project auto-restore and waveform zoom (per-source — needs a keyed map, not a single slot).

## Tests

- New layout.test.ts (jsdom): null defaults, round-trip, preservation of other layout fields, corrupt/foreign-value rejection.
- tsc + eslint clean; vitest 4/4 for the new suite.
