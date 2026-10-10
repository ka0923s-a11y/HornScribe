## Summary

Fixes #78.

The global alignment-shift estimate could phase-lock onto weak metrical positions. Two real failure modes:

- A systematic onset-detection bias made the **offbeat-16th phase** fit the fine lattice tighter than the true phase — a real Basic Pitch run over a 6/8 eighth-note line was notated one sixteenth off for the whole piece.
- Swung/triplet material let a **compromise shift** win: the Huber residual rewards spreading error, so nudging every onset slightly off the true grid traded perfect on-beats for tighter triplet fits (the swing census then read a 16/23 feel instead of 2/3).

## What changed

stimate_alignment_shift now takes the MeterMap and uses it in two places:

1. **Notatable lattice residual** — the score measures distance against the union of the fine grid and the segment's ternary beat subdivision (triplet positions the DP can actually notate). Onsets correctly sitting on triplet positions carry no residual a global shift can  improve, which removes the redistribution bias against swung material.
2. **Metrical tie-break** — coarse local minima within a widened per-weight margin (ALIGNMENT_TIEBREAK_PER_WEIGHT) are ranked by a tiered strong-grid kernel (beats > eighths > triplet thirds). A decisive leader is applied and reported as meter_resolved on the estimate, QuantizationDiagnostics.alignment_meter_resolved, and the job meta payload (lignmentMeterResolved). A tied surface still surfaces eat_alignment_uncertain; band-edge winners keep the old conservative path.

The widened eligibility matters: on the real fixture the honest candidates sit ~0.1 score units (a few per-mille of total weight) outside the old 5% relative band and never reached the disambiguation.

## Verification

- New labeled-audio benchmark scripts/bench_transcription_e2e.py (synthesizes fixtures with known note truth, runs the real worker job, scores pitch/onset): the 6/8 eighth run's median onset error drops **69.9 ms → 0.0 ms**; all four fixtures hold pitch accuracy / onset F1 = 1.0. Results committed at enchmarks/transcription_e2e.md.
- Swing pipeline test writes swingFeel: 2/3 again; latency40/latency65/ioi-pair aliases resolve silently to the correct phase (meter_resolved=True, no review flag); ambiguous same-family index aliases still flag eat_alignment_uncertain.
- pytest tests/python: **1007 passed, 3 skipped**. uff check clean.

