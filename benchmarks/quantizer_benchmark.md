# QNT-007 quantizer benchmark

- commit: `518a023ea23594c41a1f137ef201af19617bfd46` (dirty)
- quantizer: HSQ v4, weights_version=1
- fixture corpus: 33 fixtures, sha256 `be6f0222236c28b1…`

| arm | exact onset | mean onset err (ql) | exact dur | rest exact/extra | triplet fp/miss | tiny rests | runtime (s) |
|---|---|---|---|---|---|---|---|
| B0 | 0.919 | 0.012 | 0.807 | 0/33 (+0) | 0/0 | 0 | 0.004 |
| B1 | 0.919 | 0.012 | 0.807 | 0/33 (+0) | 0/0 | 0 | 0.007 |
| B2 | 0.919 | 0.012 | 0.781 | 0/33 (+0) | 0/0 | 0 | 0.620 |
| B3 | 0.970 | 0.008 | 0.869 | 31/33 (+28) | 0/0 | 26 | 0.655 |
| B4 | 1.000 | 0.000 | 1.000 | 33/33 (+0) | 0/0 | 1 | 0.682 |
| B4-no-ioi | 0.997 | 0.001 | 0.997 | 33/33 (+1) | 0/0 | 2 | 0.641 |
| B4-no-tiny-rest | 1.000 | 0.000 | 0.962 | 31/33 (+7) | 0/0 | 8 | 0.671 |
| B4-no-mode-switch | 1.000 | 0.000 | 1.000 | 33/33 (+0) | 0/0 | 1 | 0.659 |
| B3-no-ioi | 0.967 | 0.008 | 0.866 | 31/33 (+26) | 0/0 | 24 | 0.670 |

## Runtime probe (3-minute monophonic stream)

- 315 notes / 180 s audio:
  - B0: 0.004 s
  - B4: 0.948 s
