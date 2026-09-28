#!/usr/bin/env python3
"""Assemble the HornScribe portable zip (#11).

Everything the app needs sits in one folder next to the shell exe:

    HornScribe.exe                  - Tauri shell (--shell-exe)
    engine/hornscribe-engine.exe    - frozen Python worker (#83)
    tools/ffmpeg.exe, ffprobe.exe   - bundled media tools (#10)
    data/                           - portable-mode marker: its mere
                                      existence keeps recordings,
                                      projects and cache inside the
                                      zip layout (tools::data_dir)
    README-portable.txt

The staged engine is smoke-tested before zipping so a broken bundle
fails here instead of on the user machine:

    python scripts/package_portable.py
    python scripts/package_portable.py --shell-exe path/to/HornScribe.exe

Outputs under dist/:

    HornScribe-<version>-portable-win-x64.zip
    portable-size-report.{md,json}  - measured component sizes
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC_TAURI = REPO / "apps" / "desktop" / "src-tauri"
DEFAULT_SHELL = SRC_TAURI / "target" / "release" / "hornscribe-desktop.exe"
DEFAULT_ENGINE = SRC_TAURI / "resources" / "engine" / "hornscribe-engine.exe"
DEFAULT_TOOLS = SRC_TAURI / "resources" / "tools"

DATA_MARKER_README = """HornScribe portable-mode marker

This folder existing next to HornScribe.exe switches the app into
portable mode: recordings, projects, the FLAC cache and logs stay
inside this data/ directory and nothing touches %APPDATA%.

Keep the folder. Delete its contents to reset the app state."""

PORTABLE_README = """HornScribe - portable build

Run:    HornScribe.exe
Layout:
    HornScribe.exe              the app
    engine/                     bundled transcription engine
                                (no Python install needed)
    tools/                      bundled ffmpeg/ffprobe
    data/                       your recordings, projects, cache

Everything stays inside this folder - safe on a USB drive. To move
the app, move the whole folder.

The bundled ffmpeg is a static build from https://www.gyan.dev/ffmpeg/
(GPL; its license texts live in tools/). The bundled engine embeds
basic-pitch (ONNX) for offline transcription.

Optional: `pip install demucs` into your own Python adds neural vocal
separation (tools/demucs.exe also works if you stage one)."""


def _version() -> str:
    conf = json.loads((SRC_TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    return str(conf.get("version", "0.0.0"))


def _mb(n: int) -> str:
    return f"{n / 1e6:,.1f} MB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--shell-exe",
        type=Path,
        default=DEFAULT_SHELL,
        help="Tauri shell binary (default: %(default)s)",
    )
    ap.add_argument(
        "--engine-exe",
        type=Path,
        default=DEFAULT_ENGINE,
        help="frozen engine binary (default: %(default)s)",
    )
    ap.add_argument(
        "--tools-dir",
        type=Path,
        default=DEFAULT_TOOLS,
        help="staged tools dir with ffmpeg/ffprobe (default: %(default)s)",
    )
    ap.add_argument(
        "--out", type=Path, default=REPO / "dist", help="output directory (default: %(default)s)"
    )
    ap.add_argument("--version", default=None, help="override version (default: tauri.conf.json)")
    ap.add_argument("--skip-smoke", action="store_true", help="skip the staged-engine smoke test")
    ap.add_argument(
        "--keep-staging", action="store_true", help="keep the staging dir after zipping"
    )
    args = ap.parse_args()

    for p, what in ((args.shell_exe, "shell exe"), (args.engine_exe, "engine exe")):
        if not p.is_file():
            print(f"missing {what}: {p}", file=sys.stderr)
            return 2
    ffmpeg = args.tools_dir / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
    if not ffmpeg.is_file():
        print(f"missing bundled ffmpeg: {ffmpeg}", file=sys.stderr)
        print("(drop a static build into resources/tools/ first)", file=sys.stderr)
        return 2

    version = args.version or _version()
    stage = args.out / "portable" / "HornScribe"
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "engine").mkdir(parents=True)
    (stage / "tools").mkdir()
    (stage / "data").mkdir()

    # -- assemble ----------------------------------------------------------
    shell_name = "HornScribe.exe" if sys.platform == "win32" else "HornScribe"
    shutil.copy2(args.shell_exe, stage / shell_name)
    engine_name = args.engine_exe.name
    shutil.copy2(args.engine_exe, stage / "engine" / engine_name)
    for item in sorted(args.tools_dir.iterdir()):
        if item.is_file() and item.name != "README.txt":
            shutil.copy2(item, stage / "tools" / item.name)
    (stage / "data" / "README.txt").write_text(DATA_MARKER_README, encoding="utf-8")
    (stage / "README-portable.txt").write_text(PORTABLE_README, encoding="utf-8")

    # -- verify ------------------------------------------------------------
    if not args.skip_smoke:
        staged_engine = stage / "engine" / engine_name
        print("smoke-testing staged engine...")
        r = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "smoke_engine.py"), str(staged_engine)],
        )
        if r.returncode != 0:
            print("staged engine failed smoke test", file=sys.stderr)
            return 1

    # -- zip ---------------------------------------------------------------
    zip_path = args.out / f"HornScribe-{version}-portable-win-x64.zip"
    args.out.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in sorted(stage.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(stage.parent))

    # -- size report --------------------------------------------------------
    rows = []
    for label, p in (
        (shell_name, stage / shell_name),
        ("engine/" + engine_name, stage / "engine" / engine_name),
    ):
        rows.append((label, p.stat().st_size))
    for item in sorted((stage / "tools").iterdir()):
        if item.is_file():
            rows.append(("tools/" + item.name, item.stat().st_size))
    payload = sum(s for _, s in rows)

    lines = [
        f"# Portable package size report - HornScribe {version}",
        "",
        "| component | size |",
        "|---|---:|",
        *[f"| `{n}` | {_mb(s)} |" for n, s in rows],
        f"| **payload total** | **{_mb(payload)}** |",
        f"| **zip (deflated)** | **{_mb(zip_path.stat().st_size)}** |",
        "",
        f"Zip: `{zip_path.name}`",
    ]
    report_md = args.out / "portable-size-report.md"
    report_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (args.out / "portable-size-report.json").write_text(
        json.dumps(
            {
                "version": version,
                "zip": zip_path.name,
                "zipBytes": zip_path.stat().st_size,
                "payloadBytes": payload,
                "components": {n: s for n, s in rows},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print("\n".join(lines))
    print(f"report: {report_md}")

    if not args.keep_staging:
        shutil.rmtree(stage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
