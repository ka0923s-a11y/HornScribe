## Summary

Closes the remaining acceptance criteria of #147 — the referenced badge and delete warning in Settings > 録音 previously scanned only the 8-entry recent-projects MRU, so a saved project pushed out of history silently lost protection and its managed source could be deleted, later reopening as SOURCE_MISSING.

- New persistent index appDataDir/source-refs.json (project path -> sourceAudio.originalPath), written via source_refs_update and read via source_refs_index (tmp->rename atomic write, mutex-guarded).
- ImportController.openProject records the ref through a new optional updateSourceRef port — including opens that land on SOURCE_MISSING (the project file still references the source until re-saved).
- saveProjectFlow records the ref after a successful save, with the exact sourceAudio.originalPath that was written.
- Settings merges index-derived names (with per-source project counts) with the legacy MRU scan — the scan still covers projects saved before the index existed. The delete warning now names the count.
- The startup retention sweep also consults the index, so a recording referenced by an MRU-evicted project is kept too.
- Stale entries (moved/deleted projects) fail closed: treated as still-referenced. Slightly stale protection beats deleting a real project's source.

## Tests

- sourceRefCountUnder: in-dir mapping, counts, separator/case normalization, empty index.
- openProject: updateSourceRef fires with (projectPath, sourcePath) on success and on SOURCE_MISSING.
- Full suite: 526 frontend tests green, tsc + eslint clean.

## Notes

- Rust changes verified with rustfmt parse check only — the local toolchain cannot link (no VC linker), consistent with previous PRs.
