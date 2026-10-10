## Summary

Implements the full #364 surface:

- **Per-entry removal**: every 最近使ったプロジェクト row gets a keyboard-focusable `履歴から削除` icon button wired to the previously-orphaned `removeRecentProject()`.
- **Error-card recovery**: `projectOpenFailed` now carries the failed MRU `path`; the error card offers `履歴から削除して閉じる` plus `別のファイルを選ぶ` (the shared picker routes `.hornscribe.json` back to `openProject`, so it doubles as "open another project").
- **Launch-loop guard**: a failed open marks the path in a persisted auto-open skip set — the next launch skips it instead of replaying the same error. Manual opens still work; a successful open or MRU removal clears the mark. A set (not a single value) so consecutive dead entries can't ping-pong.
- **Duplicate-name disambiguation**: entries sharing a name render a parent-directory subline.
- `SOURCE_MISSING` is deliberately untouched — the project file is alive, only the source moved.

Closes #364

## Test plan

- [x] `npx tsc --noEmit` clean
- [x] `npx eslint` clean on touched files
- [x] `recentProjects.test.ts` — skip-set unit tests (skip/fall-through/all-dead/ping-pong/clear-on-open/clear-on-remove)
- [x] new `ImportStates.test.tsx` — remove button, dup-name dir subline, card remove-and-close, byte-open has no remove affordance
- [x] `controller.test.ts` + `errorRecovery.test.tsx` updated/green

🤖 Generated with Codex
