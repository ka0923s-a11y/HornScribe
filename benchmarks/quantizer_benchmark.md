# QNT-007 quantizer benchmark

- commit: `b3740d46ffbfa59aa0e3ebf5764dc6d8f592f79f`
- quantizer: HSQ v4, weights_version=1
- fixture corpus: 33 fixtures, sha256 `0c986d9d291d5907…`

| arm | exact onset | mean onset err (ql) | exact dur | rest exact/extra | triplet fp/miss | tiny rests | runtime (s) |
|---|---|---|---|---|---|---|---|
| B0 | 0.919 | 0.012 | 0.807 | 0/32 (+0) | 0/0 | 0 | 0.005 |
| B1 | 0.919 | 0.012 | 0.807 | 0/32 (+0) | 0/0 | 0 | 0.009 |
| B2 | 0.919 | 0.012 | 0.781 | 0/32 (+0) | 0/0 | 0 | 0.739 |
| B3 | 0.970 | 0.008 | 0.869 | 30/32 (+29) | 0/0 | 26 | 1.059 |
| B4 | 1.000 | 0.000 | 1.000 | 32/32 (+1) | 0/0 | 1 | 1.065 |
| B4-no-ioi | 0.997 | 0.001 | 0.997 | 32/32 (+2) | 0/0 | 2 | 1.034 |
| B4-no-tiny-rest | 1.000 | 0.000 | 0.962 | 30/32 (+8) | 0/0 | 8 | 1.040 |
| B4-no-mode-switch | 1.000 | 0.000 | 1.000 | 32/32 (+1) | 0/0 | 1 | 1.046 |
| B3-no-ioi | 0.967 | 0.008 | 0.866 | 30/32 (+27) | 0/0 | 24 | 1.033 |

## Runtime probe (3-minute monophonic stream)

- 315 notes / 180 s audio:
  - B0: 0.007 s
  - B4: 1.315 s
