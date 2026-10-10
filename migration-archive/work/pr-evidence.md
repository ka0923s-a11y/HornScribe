## Summary

Follow-up to #85 (two-voice texture). The engine already reports the voice-split outcome in ReviewIssue.evidence (secondVoiceNotes / droppedBeyondVoices / polyphonicOverlaps), but the UI's reasonDetail only received the reason code, so the user saw the generic "複数の候補が重なって検出されました" with no idea whether a second voice was kept or notes were silently lost.

- InspectorCopy.reviewDetail now takes the full ScoreReviewIssue so the copy layer can read evidence.
- New ja.reviewEvidence deck: voices texture shows "重なった音を第2声部として N 個残しました" plus a dropped-beyond-two-voices count when non-zero; monophonic merges show the overlap count and warn a voice may have been lost.
- Falls back to the generic per-reason detail when no matching evidence keys exist.
- New numEvidence(issue, key) helper in score/review.ts next to issueConfidence.

Used by both surfaces that render issue detail: the review bar and the note inspector rows.

## Tests

- inspector.test.ts mock updated for the new signature; tsc + eslint clean; vitest 6/6 (inspector).
