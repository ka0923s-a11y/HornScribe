# Engine runtime compatibility matrix (FND-002)

> Status: Measured 2026-09-22 on Windows 11 (10.0.26200), x86-64.
> Reproduce with `scripts/bench_engine_runtime.py` (see commands below).
> Raw benchmark JSONs were captured per run (pip freeze embedded).

## Decision

**Selected engine runtime: Python 3.12 + Basic Pitch 0.4.0 via ONNX Runtime.**

Python 3.11 remains the declared-fallback path (officially supported by
upstream metadata, measured below). Python 3.10 is excluded as a baseline —
it reaches EOL in October 2026. Python 3.14+ is a documented migration
candidate once the scientific stack is fully stable there.

## Measured results

| Candidate | Install path | Backend | Import | Model init | 3 s audio | 30 s audio | Peak RAM |
|---|---|---|---|---|---|---|---|
| Python 3.10.11 | `pip install basic-pitch==0.4.0` (official) | onnxruntime 1.23.2 | 0.27–1.31 s | 0.10–0.14 s | 32.8 s¹ | 7.44 s | 240–339 MB |
| Python 3.11.9 | `pip install basic-pitch==0.4.0` (official) | tensorflow 2.15.0 | 9.4–22.5 s | 1.9–2.2 s | 35.3 s¹ | 4.91 s | 548–632 MB |
| Python 3.12.10 | `--no-deps` wheel + explicit deps | onnxruntime 1.30.0 | 0.54 s | 0.16 s | 3.55 s | 4.43 s | 227–251 MB |
| Python 3.14.5 | `--no-deps` wheel + explicit deps | onnxruntime 1.30.0 | 1.61 s | 0.11 s | 1.20 s | — | 198 MB |

¹ First-inference outliers: ONNX session/TF graph warmup dominates a 3 s
probe. The 30 s column is representative of steady-state throughput.

### Packaging (Python 3.12 + ONNX path)

- PyInstaller 6.22.3 `--onefile` freeze of a real `basic_pitch` ONNX
  inference smoke binary: **succeeds**
- Sidecar size: **128.7 MB** (`basic_pitch` collected with model assets)
- Cold start incl. model load: **7.6 s**
- Packaged binary runs fully offline (no model download — `nmp.onnx`,
  230 444 B, ships inside the wheel)

### Why the `--no-deps` workaround on 3.12/3.14

`basic-pitch==0.4.0` declares
`tensorflow>=2.4.1,<2.15.1 ; platform_system != "Windows" or platform_system == "Windows" and python_version >= "3.11"`
— i.e. on Windows + Python ≥3.11 the resolver *requires* a TensorFlow that
does not exist for 3.12+ (`tensorflow<2.15.1` tops out at Python 3.11).
Plain `pip install basic-pitch` therefore **fails** on 3.12/3.14.

The package is import- and inference-clean without TensorFlow when the ONNX
runtime is supplied explicitly:

```text
pip download basic-pitch==0.4.0 --no-deps
pip install --no-deps basic_pitch-0.4.0-py2.py3-none-any.whl
pip install onnxruntime librosa mir-eval "numpy<2" pretty-midi \
            "resampy<0.4.3" scikit-learn scipy typing-extensions \
            "setuptools<81"   # resampy still imports pkg_resources
```

`Model(".../saved_models/icassp_2022/nmp.onnx")` + `predict()` verified
end-to-end on both 3.12 and 3.14.

## Reproduction

```bat
py -3.12 -m venv .venv-bp
.venv-bp\Scripts\python -m pip download basic-pitch==0.4.0 --no-deps -d .work\bp_pkg
.venv-bp\Scripts\python -m pip install --no-deps .work\bp_pkg\basic_pitch-0.4.0-py2.py3-none-any.whl
.venv-bp\Scripts\python -m pip install onnxruntime librosa mir-eval "numpy<2" pretty-midi "resampy<0.4.3" scikit-learn scipy typing-extensions "setuptools<81" psutil
.venv-bp\Scripts\python scripts\bench_engine_runtime.py --audio-sec 30 --out bench.json
```

Freeze check:

```bat
.venv-bp\Scripts\python -m pip install pyinstaller
.venv-bp\Scripts\python -m PyInstaller --onefile --collect-all basic_pitch sidecar_smoke.py
```

## Candidate notes

- **3.10**: works, ONNX runtime pinned to 1.23.2 by the resolver; EOL
  2026-10 makes it a compatibility reference only, per plan.
- **3.11**: fully official upstream path but pulls TensorFlow 2.15
  (~600 MB wheel, 9–22 s import, 632 MB peak RAM) — heaviest option.
- **3.12**: unofficial-but-proven ONNX path; CPython support to Oct 2028;
  smallest/fasting working configuration; PyInstaller freeze verified.
- **3.14**: also works via the same ONNX workaround and is the fastest
  measured; too new to anchor v1 on (packaging tooling, numba/llvmlite
  freshness). Migration candidate.
- **Cancellation**: Basic Pitch inference is a blocking C++/ONNX call;
  cooperative cancel inside a call is not reliable. Engine-sidecar design
  (ADR-0002) must keep worker terminate/restart as the cancellation
  fallback — to be exercised by the UI-002 spike, per plan §4.6.

## Lifecycle & migration triggers

- Re-evaluate when upstream `basic-pitch` publishes a release whose
  declared Python range covers 3.12+ (upstream work is in progress).
- Re-evaluate on Python 3.12 EOL approach (Oct 2028) or if a dependency
  (onnxruntime, librosa, music21) drops 3.12 earlier.
- If the `--no-deps` path ever breaks on a dependency upgrade, the lock
  files captured in the bench JSONs are the known-good set; fall back to
  Python 3.11 + TF meanwhile.
