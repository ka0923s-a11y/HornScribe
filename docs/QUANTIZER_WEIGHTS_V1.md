# Quantizer Weights v1 — freeze record (QNT-007)

`weights_version = 1` freezes the `QuantizerWeights` defaults that ship as
`QuantizationProfile.standard()`. The values are benchmarked against the
deterministic `ALL_FIXTURES` corpus; the committed evidence lives in
`benchmarks/quantizer_benchmark.json` (+ `.md` summary).

## Frozen values

| weight | v1 |
|---|---|
| onset | 4.0 |
| ioi | 2.0 |
| offset | 1.0 |
| symbol | 0.55 |
| tie | 0.45 |
| first_dot | 0.08 |
| second_dot | 0.35 |
| tuplet_group | 1.20 |
| tuplet_atom | 0.12 |
| mode_switch | 0.70 |
| tiny_rest | 0.75 |
| weak_boundary_crossing | 0.90 |
| strong_boundary_crossing | 1.40 |

These are the design-31 starting values; the benchmark showed they already
satisfy the acceptance evidence below, so v1 freezes them unchanged rather
than tuning for its own sake.

## Reproduction

```text
.venv/Scripts/python scripts/bench_quantizer.py
# -> benchmarks/quantizer_benchmark.json + .md
```

Private horn recordings (gitignored `benchmarks/local/*.json`, format
documented in `scripts/bench_quantizer.py`) are benchmarked with
`--local` into `benchmarks/local/results_local.json` — never committed.

## Benchmark headline (33 fixtures, corpus sha256 recorded in the artifact)

| arm | exact onset | exact dur | rest exact/extra | triplet fp/miss | tiny rests |
|---|---|---|---|---|---|
| B0 nearest-16th | 0.919 | 0.807 | 0/32 (+0) | - | - |
| B1 nearest lattice | 0.919 | 0.807 | 0/32 (+0) | - | - |
| B2 music21 quantize | 0.919 | 0.781 | 0/32 (+0) | - | - |
| B3 HSQ timing-only | 0.970 | 0.869 | 30/32 (+29) | 0/0 | 26 |
| **B4 HSQ-v1** | **1.000** | **1.000** | **32/32 (+1)** | **0/0** | **1** |

B4 beats every baseline on onset accuracy, note-value accuracy and rest
correctness, with zero triplet false positives/misses and essentially no
spurious tiny rests (the single tiny rest is the *real* sixteenth rest in
`rests_sixteenth`).

## Ablation findings (contribution of individual cost terms)

- **No IOI (`B4-no-ioi`)**: onset rate drops to 0.997 — the IOI term rescues
  `eighths_jitter80` (±80 ms) onsets (0.917 without it). In the timing-only
  context (`B3-no-ioi` vs `B3`) it is also the term that recovers the
  `ioi_pair` fixture (design 10.2).
- **No tiny-rest (`B4-no-tiny-rest`)**: +8 extra rests, 8 spurious tiny
  rests, rest exact drops to 30/32 and duration rate to 0.962 — the
  articulation/breath-gap fixtures fragment into sixteenth rests.
- **No mode-switch (`B4-no-mode-switch`)**: **no measurable output change**
  on the whole corpus. The barrier is kept as a safety rail (it can only
  raise triplet-mode cost, never create false positives), but honest
  record: v1 evidence does not show it contributing.
- **Timing-only (`B3`)**: 29 extra rests / 26 tiny rests vs B4 — the
  notation-complexity terms are what keep tonguing gaps and breath lifts
  from becoming rests.

## Known failure classes / limits (honest record)

- `eighths_jitter80` emits **one extra rest** under B4 — ±80 ms jitter can
  still realize a spurious gap. Rare, surfaced via review issues.
- Alignment search flags `beat_alignment_uncertain` on latency/jitter
  fixtures instead of silently shifting — review burden is measured
  (`review_issue_count`), not hidden.
- No real horn recordings in the committed corpus — `--local` covers that
  path; corpus is synthetic/deterministic by design.
- User-correction metrics are not measurable from synthetic fixtures;
  review-issue count is the proxy recorded in the artifact.
- MUSTER comparison not run (no external corpus wired in); onset error in
  ql is the recorded equivalent.

## Production readiness

HSQ-v1 (weights v1) is benchmark-superior to the naive and music21
baselines on the required metrics and is the shipped default. It is **not**
claimed production-proven on real recordings — the corpus is synthetic;
the local-corpus path exists for that validation.
