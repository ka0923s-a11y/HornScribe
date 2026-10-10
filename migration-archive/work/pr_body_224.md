## Summary

Fixes #224: the canonical ScoreDocument is now the single source of truth for engine edits. Pending overlay edits (pitchDelta / deleted) are materialized into the canonical payload before score.edit, so split/merge/requantize can never resurrect or contradict what the user sees.

**Domain (Python)**
- `QuantizedNote.deleted` — canonical record of the UI-050 delete. Rest-rendered but keeps its `sn-*` id (ScoreRest carries no identity), so selection/issue links and restore survive. Serialized only when true (older payloads keep their revision ids).
- `to_music21`: deleted notes emit rests carrying their `hs-sn-*` id; a deleted chord member drops out of the chord (surviving members cover the slot, matching the frontend normalizeChords); a fully deleted group collapses to one id-keeping rest.
- `musicxml._assign_note_ids`: rests with `hs-sn-*` ids get fragment numbering like pitched notes instead of consuming a canonical rest ordinal.
- `scoreedit`: split/timing/transpose carry the flag via replace(); merge = deleted only when BOTH inputs deleted; `_remap_note_ids` carries deleted positionally AND via shared source_event_ids (a deleted note re-split by requantize stays deleted); `restToNote` on a deleted note restores it (keeps id/pitch/span).

**Frontend**
- `XmlScoreDocument.canonicalDocument()` returns the payload with overlay edits materialized (pitchDelta → pitchMidi, deleted → canonical flag, both directions). `buildProjectDocument` inherits this for free, fixing the project-reopen divergence (issue example 4).
- `setNoteEdit` is canonical-aware: {deleted:false} on a canonical-deleted note is a real restore marker, {deleted:true} is neutral.
- `applyNoteEdits` can now RESTORE: an overlay `deleted:false` on a canonical-deleted note re-pitches the emitted rest from canonical pitchMidi.
- `editOf`/`isDeleted` merge canonical deleted state; undo snapshots carry the overlay map (`noteEdits` in contentSnapshot/replaceContent) so undo/redo of rhythm edits restores edits correctly.
- `materializedNoteEdits(newCanonical)` computes the surviving overlay (enharmonic-only on live notes) — applied after each engine swap.
- project save emits a `restore` userEdit for overlay-restored canonical-deleted notes.

**Tests**: 8 new Python tests (flag roundtrip, split/merge propagation, requantize non-resurrection, restToNote restore, MusicXML rest+id emission) + 4 new TS tests (materialization, surviving-overlay, undo snapshot, restore markers). 815 Python + 536 frontend tests green; ruff/mypy/tsc/eslint clean.

## Notes

- Remaining gap (pre-existing): userEdits are persisted but not re-applied on project open — baked canonical edits now survive reopen (materialized), while unmaterialized enharmonic overlays still rely on baked XML. Worth a follow-up issue.
