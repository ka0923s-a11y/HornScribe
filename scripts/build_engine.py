#!/usr/bin/env python3
"""Build the frozen engine sidecar for packaged apps (#83).

Produces ``apps/desktop/src-tauri/resources/engine/hornscribe-engine/``
— a PyInstaller ONEDIR bundle (``hornscribe-engine.exe`` + ``_internal/``)
that speaks the worker NDJSON protocol on stdin/stdout, so
``engine_spawn`` can launch it directly without a Python install.

#186: onedir, not onefile — a onefile build re-extracts ~290 MB into
%TEMP% on EVERY launch (cold start ~40-60s on a loaded machine, every
extract re-scanned by AV), and its bootloader re-execs the worker as a
grandchild that plain kill() cannot reach. The onedir bootloader loads
Python in-process: instant start, single process, clean kill.

Run inside the engine venv (the one with ``hornscribe[engine]``
installed — basic_pitch/onnxruntime/librosa/music21):

    pip install pyinstaller
    python scripts/build_engine.py

Then package with the engine bundled:

    cd apps/desktop && npx tauri build --config src-tauri/tauri.bundled.json

Size note: the bundle embeds the ONNX model + onnxruntime + numpy, so
expect ~450-700 MB unpacked (it compresses back to ~300 MB inside the
installer/zip — the onefile payload decompressed to the same size at
runtime anyway). That is the cost of fully-offline, free-tier
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
        "--onedir",
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

    # #186: onedir lands at <OUT_DIR>/hornscribe-engine/<name>[.exe]
    # next to its _internal/ payload.
    exe = (
        OUT_DIR
        / "hornscribe-engine"
        / ("hornscribe-engine.exe" if sys.platform == "win32" else "hornscribe-engine")
    )
    if not exe.is_file():
        print(f"expected output missing: {exe}", file=sys.stderr)
        return 1
    total = sum(p.stat().st_size for p in exe.parent.rglob("*") if p.is_file())
    print(f"bundled engine: {exe} ({total / 1e6:.0f} MB unpacked)")
    return 0


def _has_pyinstaller() -> bool:
    try:
        import PyInstaller  # noqa: F401
        return True
    except ImportError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
