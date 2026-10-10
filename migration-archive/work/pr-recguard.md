## Summary

Partial fix for #132 (option 1: exclude referenced recordings). The retention sweep no longer deletes a recording that a saved project still references:

- pruneRecordings(days, keepNames) accepts a set of protected file names.
- New collectReferencedRecordingNames reads each recent project's sourceAudio.originalPath (via the import ports' readProjectBytes + parseProjectFile) and keeps names inside the recordings dir. The prefix match is case- and slash-insensitive; a similarly-named sibling dir (recordings2) is not protected. Unreadable projects fail open — their references stay unknown and the retention policy applies as before.
- App.tsx collects the protected set (recordings dir from recordings_info) before the startup prune.

Coverage note: only projects in the MRU list (max 8) are scanned — a project file moved elsewhere and never opened recently can still reference a recording that gets pruned. The managed-copy option (issue option 3) remains the complete fix; noted in #132.

## Tests

- recordings.test.ts: keeps in-dir sources, ignores outside paths, fail-open on unreadable projects, no protection without a dir, case/slash-insensitive prefix, sibling-dir exclusion. tsc + eslint clean; vitest 5/5.
