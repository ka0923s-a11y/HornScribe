#!/usr/bin/env python3
"""Build the frozen engine sidecar for packaged apps (#83).

Produces ``apps/desktop/src-tauri/resources/engine/hornscribe-engine``
(``.exe`` on Windows) — a PyInstaller onefile binary that speaks the
worker NDJSON protocol on stdin/stdout, so ``engine_spawn`` can launch
it directly without a Python install.

Run inside the engine venv (the one with ``hornscribe[engine]``
installed — basic_pitch/onnxruntime/librosa/music21):

    pip install pyinstaller
    python scripts/build_engine.py

Then package with the engine bundled:

    cd apps/desktop && npx tauri build --config src-tauri/tauri.bundled.json

Size note: the binary embeds the ONNX model + onnxruntime + numpy, so
expect ~150-250 MB. That is the cost of fully-offline, free-tier
transcription — recorded on issue #83.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "apps" / "desktop" / "src-tauri" / "resources" / "engine"
DIST_DIR = REPO / ".work" / "pyinstaller"


def main() -> int:
    if shutil.which("pyinstaller") is None and not _has_pyinstaller():
        print("pyinstaller is required: pip install pyinstaller", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    entry = REPO / "python" / "hornscribe" / "worker" / "__main__.py"
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name",
        "hornscribe-engine",
        "--distpath",
        str(OUT_DIR),
        "--workpath",
        str(DIST_DIR / "build"),
        "--specpath",
        str(DIST_DIR),
        # hornscribe package root (not installed as a wheel in dev).
        "--paths",
        str(REPO / "python"),
        # Data files: basic_pitch ships the ONNX model via
        # importlib.resources; music21 ships corpora/metadata.
        "--collect-all",
        "basic_pitch",
        "--collect-all",
        "music21",
        # Lazy engine deps (backend.py imports them inside functions).
        "--collect-submodules",
        "hornscribe",
        "--hidden-import",
        "librosa",
        "--hidden-import",
        "onnxruntime",
        "--hidden-import",
        "soundfile",
        "--hidden-import",
        "numba",
        str(entry),
    ]
    print(" ".join(args))
    result = subprocess.run(args, cwd=REPO)
    if result.returncode != 0:
        return result.returncode

    exe = OUT_DIR / ("hornscribe-engine.exe" if sys.platform == "win32" else "hornscribe-engine")
    if not exe.is_file():
        print(f"expected output missing: {exe}", file=sys.stderr)
        return 1
    print(f"bundled engine: {exe} ({exe.stat().st_size / 1e6:.0f} MB)")
    return 0


def _has_pyinstaller() -> bool:
    try:
        import PyInstaller  # noqa: F401
        return True
    except ImportError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
