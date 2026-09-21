"""``hornscribe`` command line entry point."""

from __future__ import annotations

import argparse
import importlib.util
import shutil
import sys

import hornscribe


def _doctor() -> int:
    """Report local dependency availability. Read-only; never installs."""
    checks: list[tuple[str, bool, str]] = []
    checks.append(("python>=3.11", sys.version_info >= (3, 11), sys.version.split()[0]))
    for module in ("music21", "basic_pitch", "librosa", "pretty_midi", "mido"):
        spec = importlib.util.find_spec(module)
        checks.append((f"module:{module}", spec is not None, "" if spec else "not installed"))
    for exe in ("ffmpeg", "ffprobe", "musescore"):
        found = shutil.which(exe)
        checks.append((f"exe:{exe}", found is not None, found or "not found"))
    width = max(len(name) for name, _, _ in checks)
    for name, ok, detail in checks:
        status = "ok" if ok else "missing"
        print(f"{name:<{width}}  {status:<8} {detail}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hornscribe", description="HornScribe engine CLI")
    version = f"hornscribe {hornscribe.__version__}"
    parser.add_argument("--version", action="version", version=version)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check local dependencies")
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
