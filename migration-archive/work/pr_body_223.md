## Summary
- Fixes #223: the schema's rawResultRef/scoreRef were dangling — they named cache artifacts nothing ever wrote. Raw evidence now travels INLINE on the scoreDocument (rawEvidence: cleaned events per part + the seconds->ql warp), which the project file already stores verbatim, so raw detection data survives saves/restarts with no cache machinery. The refs become optional in the model and the published v1 schema (old files keep them; new saves drop them).
- Fixes #226: requantize used to replay the already-quantized notation as synthetic events through an identity warp — re-rounding the rounding, unable to recover anything the first pass absorbed. With evidence present, _apply_requantize replays the persisted events through the ORIGINAL warp under the merged profile: a finer min-duration resurfaces short notes, and triplet policy re-decides from real timing. Part 1 re-searches its alignment shift; later parts inherit it (mirrors the pipeline so voices cannot drift). source_event_ids bind to real persisted events.
- Documents without evidence (older projects, hand-built scores) keep the synthetic path — reported as requantizeMode=synthetic vs rawEvidence so the UI can label the degraded mode honestly (「簡易モード」 feedback in the requantize toast).

## Tests
- test_scoreedit.py::TestRequantizeEvidence — evidence round-trip, finer-minDuration recovery, malformed-evidence fallback, mode reporting.
- test_transcription.py::TestRawEvidence — pipeline emits rawEvidence on the completed scoreDocument; survives a document dict round-trip.
- test_project.py — optional-ref project round-trip.
- Full suite: 807 python passed; ruff + mypy + tsc + eslint clean.

## Notes
- The schema description in project-v1.schema.json already tolerates additional root properties; rawEvidence lives inside scoreDocument (loosely typed) so no schema bump is needed.

