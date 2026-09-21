"""FND-002 runtime measurement harness.

Run inside the candidate venv:
    python scripts/bench_engine_runtime.py --audio-sec 30 --out result.json

Measures: interpreter info, dependency lock, import time, model init,
inference wall time, and peak process RAM (psutil if available).
"""

from __future__ import annotations

import argparse
import importlib
import json
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def _generate_tone(path: Path, seconds: float, sr: int = 22050) -> None:
    import numpy as np
    import scipy.io.wavfile as wav

    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sig = (np.sin(2 * np.pi * 261.63 * t) * 0.3).astype(np.float32)
    wav.write(path, sr, sig)


def _peak_ram_mb() -> float | None:
    try:
        import psutil

        return psutil.Process().memory_info().peak_wset / (1024 * 1024)
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-sec", type=float, default=30.0)
    parser.add_argument("--model", type=str, default=None, help="explicit model path")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    result: dict[str, object] = {
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    freeze = subprocess.run(
        [sys.executable, "-m", "pip", "freeze"], capture_output=True, text=True, check=False
    )
    result["pip_freeze"] = sorted(freeze.stdout.strip().splitlines())

    t0 = time.perf_counter()
    bp = importlib.import_module("basic_pitch")
    result["import_sec"] = round(time.perf_counter() - t0, 3)
    result["basic_pitch_version"] = getattr(bp, "__version__", "unknown")

    model_path = (
        Path(args.model)
        if args.model
        else Path(bp.__file__).parent / "saved_models" / "icassp_2022" / "nmp.onnx"
    )
    result["model"] = str(model_path)
    result["model_size_bytes"] = model_path.stat().st_size

    from basic_pitch.inference import Model, predict

    t0 = time.perf_counter()
    model = Model(str(model_path))
    result["model_init_sec"] = round(time.perf_counter() - t0, 3)

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "tone.wav"
        _generate_tone(wav_path, args.audio_sec)
        t0 = time.perf_counter()
        output = predict(str(wav_path), model)
        result["inference_sec"] = round(time.perf_counter() - t0, 3)
        result["audio_sec"] = args.audio_sec
        note_events = output[2] if isinstance(output, tuple) and len(output) > 2 else None
        result["note_events_type"] = type(note_events).__name__

    result["peak_ram_mb"] = _peak_ram_mb()
    blob = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        args.out.write_text(blob + "\n", encoding="utf-8")
    print(blob)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
