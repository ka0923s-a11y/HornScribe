## Summary

When the auto/mono texture detects a dense mix, the only one-click remedy was 複数声部として採譜 (voices). For the common JPOP case — accompaniment + lead vocal — the better remedy is isolating the vocal, which was already implemented (#187) but never suggested, so users couldn't discover it.

- Pipeline: `overlapping_candidates` evidence gains `suggestVocalIsolation` (true only when a mix was detected AND vocal isolation wasn't already used).
- `buildReviewAction`: new `retranscribeVocalIsolation` remedy — wins over the voices offer on a lead-vocal mix (the product's primary deliverable is the single playable melody line).
- `onRetranscribeVocalIsolation` wired App → ScoreWorkspace → ScoreReadyWorkspace: pins `texture:melody + vocalIsolation:true` into options and the job overrides.
- `transcribe` override type gains `vocalIsolation`.

## Verification

- `pytest` — new `test_mix_suggests_vocal_isolation_until_used` passes; ruff/mypy clean
- `vitest` — reviewActions 17 pass; `tsc --noEmit` clean

Closes #314.
