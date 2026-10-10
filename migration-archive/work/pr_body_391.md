## Summary

Closes #391.

`ProjectStore` snapshots the previous good file to
`<name>.hornscribe.json.recovery` on every save — but the desktop open
path never consulted it, so a corrupt/truncated main file ended in
`projectOpenFailed` while a good copy sat next to it.

### Worker (`project.open`)

- `{path}` opens now retry the sibling `.recovery` through the
  identical `migrate_project_dict` + `HornScribeProject.from_dict`
  funnel whenever the main file fails — unreadable, non-JSON, bad
  schema, failed validation (covers more than `store.py load()`, which
  only falls back on read/parse errors).
- A successful fallback returns `"recovered": true`; when the sibling
  is absent or also broken, the original main-file failure surfaces.
- `documentBase64` opens have no sibling and never set `recovered`.

### Desktop

- `inspectProject`/`ProjectSummary`/`onProjectScoreReady` carry
  `recovered` end-to-end (path opens, byte-opens, SOURCE_MISSING and
  relink surfaces).
- `announceOpened` makes the restore notice outrank the routine
  opened/loaded/relinked message: `前回保存時のバックアップから復元しました…`
  tells the user the main file was unreadable and Ctrl+S repairs it.
- `App` keeps `projectPath` as the save target but leaves
  `savedEditVersionRef` null — the restored doc opens **dirty**, so
  the next `project.save` writes the recovered content back over the
  broken main file (which then becomes the new `.recovery`).
- `PROTOCOL.md` documents the field and draws the line against the
  appData autosave (unsaved-edit crash recovery — launch-time, prompt-
  gated, and still owns the session before MRU restore).

### Tests

- `test_worker.py`: truncated-main+valid-recovery fixture with
  save-after-restore round-trip; valid main ignores the sibling;
  missing main uses it; broken pair still fails closed on the main
  error.
- `controller.test.ts`: a `recovered:true` inspect result flags the
  project on `onProjectScoreReady` and announces the backup message.

40 vitest / 12 pytest / tsc / eslint / ruff / mypy green.