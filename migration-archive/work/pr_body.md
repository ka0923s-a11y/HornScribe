Closes #5

## What

Independent boundary re-scoring expert (orig #423). Most transcription damage lives at note EDGES — a missed onset becomes one long note, an imagined re-articulation becomes two. Backends draw edges and nothing re-checks them. This adds a second opinion that scores every cleaned edge against the audio itself and surfaces the suspicious ones as one-click review actions.

### Engine (`transcription/boundary.py`, numpy-only)

- Spectral-flux onset function + same-geometry RMS envelope on Hann windows (2048/512). Runs in every engine env — librosa stays a decode-time dependency, never a scoring one, so the thresholds are deterministic across versions.
- **merge** — contiguous same-pitch events whose shared edge has no separation evidence: no onset peak, no silence trough, no f0 jump in the tracked contour. One held note written as two.
- **split** — an interior onset that rivals the note own attack, damped 0.5x when the candidate lands on a vibrato bend extremum (a swell accent is not a re-articulation).
- **uncertain** — a pitch-changing edge with no attack and no gap. Legato is legitimate; the backend just cannot prove its own boundary.

### Pipeline mapping (`_boundary_issues`)

- Flags map through `source_event_ids` onto canonical notes, and only become `boundary_uncertain` review issues when the suggested fix can actually apply: merge requires same part + same written pitch + exact adjacency (`a.end_beat == b.start_beat`); split requires the flagged second strictly inside the note's beat span and ships `suggestedSplitBeat`. Flags that quantized away are dropped.
- Severities: merge/split = CAUTION, uncertain = INFO; capped at 20.

### One-click remedies

- `splitNote` now accepts `startBeat` — the review action splits on the onset the expert heard (snapped to the min grid); a bare split keeps the midpoint.
- Review bar: merge flag → "2音を1つにまとめる" (`mergeNotes`), split flag → "この位置で音を分ける" (`splitNote` at `suggestedSplitBeat`), uncertain → no auto-fix (listening IS the answer).
- Evidence copy names the suggested fix + confidence; `boundary_uncertain` added to the reason deck and to `protocol/copy/ja-JP.json` (which was also missing `pickup_uncertain` — filled that gap too).

## Tests

- `test_boundary.py`: 16 cases — merge/split/uncertain detection, silence-gap + f0-jump suppression, vibrato damp, short-span skip, absolute-second offset, and the flags-to-issue gating (adjacency, span containment, severity).
- `test_scoreedit.py`: split at `startBeat` + outside-span rejection.
- `reviewActions.test.ts`: merge/split op shapes, feedback strings, uncertain no-action.
- `test_review.py` enum contract updated.

## Verification

- pytest tests/python: full suite green (see below)
- vitest 24/24 reviewActions, tsc --noEmit clean, eslint clean, ruff clean

## Notes

- Envelopes are per-voice `O(audio)`; a transient frame matrix is allocated per call (bounded by analysis length).
- JSON copy deck gained `pickup_uncertain` alongside `boundary_uncertain` — it was emitted by #358 but never added to the canonical deck.
