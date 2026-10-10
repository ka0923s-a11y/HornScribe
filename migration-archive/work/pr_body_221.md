## Summary
Implements the project lifecycle from #221: the score now knows which file it belongs to, unsaved work is visible and guarded, and a crash no longer silently loses edits.

- **Save target / Save As**: an opened `.hornscribe.json` becomes the save target (`onProjectScoreReady` now carries `project.path`); Ctrl+S writes back in place, new `project.saveAs` (Ctrl+Shift+S) always re-picks. Both live in the overflow menu with `Save24Regular`/`SaveEdit24Regular` icons.
- **Dirty tracking**: `savedEditVersionRef` vs `doc.editVersion`, mirrored by a 500 ms poll (the port counter is not reactive). Title bar shows `name *`; the baseline is pinned to the serialized version so edits during the async write stay dirty.
- **Autosave + recovery**: while dirty, a 3 s debounce writes the schema-v1 document to `appDataDir/autosave.hornscribe.json` (tmp+rename) via new `project_autosave_write`/`status`/`clear` commands. A `.meta.json` sidecar records the path the snapshot was taken against so restore re-points Ctrl+S at the original file. On launch the status probe arms a 復元しますか dialog; the MRU restore waits for it.
- **Destructive-nav guards**: 未保存の変更を破棄しますか (save-and-continue / discard / cancel) wraps open audio/project (dialog, MRU, issue-dialog retry), native + HTML5 drops, re-transcription (incl. voices/basicPitch quick actions), and capture start. `beforeunload` now also guards on dirty.
- **Fix**: `updateSourceRef` no longer indexes byte-opened projects under an empty path key.

## Test plan
- `npx tsc --noEmit` clean; `npx eslint` clean on touched files
- `npx vitest run` — 537 tests pass (new: save pair gating/shortcut test, `scoreProjectPaths` assertion in openProject)
- Rust: `rustfmt --emit stdout` parses clean. cargo build unavailable in this env (no VC linker) — CI `cargo check --locked` covers it; `serde_json` already a dependency.
- Manual verification of the dialogs/autosave file requires the packaged app (Tauri-only commands honest-no-op in browser dev).

Closes #221
