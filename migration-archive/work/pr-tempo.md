## Summary

GUI_UX_SPEC §14 lists BPM as an undoable edit target. This adds it end to end:

- **Engine** (scoreedit.py): new setTempo edit kind. It replaces the beat-0 TempoSegment (or prepends one when the map is empty / starts later) and keeps later segments, so a mid-piece tempo change survives a head-tempo correction. bpm is validated to the 20-400 range; noteId is optional for this kind. No re-tiling needed - the payload returns untouched apart from tempo_map, and the revision re-derives from content.
- **Desktop**: the properties panel's score summary tempo row becomes an editable BPM field (HsNumericField). It commits on blur / Enter / stepper click - not per keystroke, so typing "96" doesn't fire two engine edits. Out-of-range input shows a field error and never reaches the engine. The draft re-syncs whenever the engine reports a new tempo (edit, undo, different score).
- ScoreWorkspaceController.setTempo(bpm) routes through the same serialized rhythmQueue + shared commitDocSwap undo stack as the other rhythm edits - Ctrl+Z restores the previous tempo.

## Bug fix included

import/project.ts previously saved the **job result's** scoreDocument. After an engine rhythm edit the live document's canonical payload is newer, so saving a project would silently lose the edits on reopen (the XML bodies were already correct - only the canonical payload was stale). Now saves doc.canonicalDocument?.() with the result payload as fallback.

## Tests

- test_scoreedit.py: +8 cases - head-segment replace, later-segment preservation, prepend on empty/later-starting map, missing/out-of-range/non-numeric bpm rejection, notes untouched, revision changes.
- project.test.ts: live-canonical save + fallback to the job result.
- Verified: pytest 22/22 (scoreedit), ruff, mypy clean; tsc, eslint clean; vitest 392/392.

Refs #115 (§14 BPM undo target).
