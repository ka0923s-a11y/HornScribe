"""#11: package_portable.py assembles a self-contained zip layout."""

from __future__ import annotations

import importlib.util
import json
import sys
import zipfile
from pathlib import Path

import pytest


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "package_portable", Path(__file__).parents[2] / "scripts" / "package_portable.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def stage_inputs(tmp_path: Path):
    shell = tmp_path / "hornscribe-desktop.exe"
    shell.write_bytes(b"MZ-fake-shell")
    engine = tmp_path / "engine" / "hornscribe-engine.exe"
    engine.parent.mkdir()
    engine.write_bytes(b"MZ-fake-engine")
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "ffmpeg.exe").write_bytes(b"MZ-fake-ffmpeg")
    (tools / "ffprobe.exe").write_bytes(b"MZ-fake-ffprobe")
    (tools / "LICENSE-ffmpeg.txt").write_text("gpl", encoding="utf-8")
    (tools / "README.txt").write_text("staging doc", encoding="utf-8")
    return shell, engine, tools


def _run(mod, argv):
    old = sys.argv
    sys.argv = ["package_portable.py", *argv]
    try:
        return mod.main()
    finally:
        sys.argv = old


def test_zip_layout_and_report(tmp_path: Path, stage_inputs):
    mod = _load_module()
    shell, engine, tools = stage_inputs
    out = tmp_path / "dist"
    rc = _run(
        mod,
        [
            "--shell-exe", str(shell),
            "--engine-exe", str(engine),
            "--tools-dir", str(tools),
            "--out", str(out),
            "--version", "9.9.9",
            "--skip-smoke",
            "--keep-staging",
        ],
    )
    assert rc == 0

    zip_path = out / "HornScribe-9.9.9-portable-win-x64.zip"
    names = set(zipfile.ZipFile(zip_path).namelist())
    # Zip must be importable-clean: single HornScribe/ root with the
    # exe-dir layout tools::data_dir / resolve_ffmpeg understand.
    assert "HornScribe/HornScribe.exe" in names
    assert "HornScribe/engine/hornscribe-engine.exe" in names
    assert "HornScribe/tools/ffmpeg.exe" in names
    assert "HornScribe/tools/ffprobe.exe" in names
    assert "HornScribe/tools/LICENSE-ffmpeg.txt" in names
    # Portable-mode marker survives zipping (dir entry + placeholder).
    assert "HornScribe/data/README.txt" in names
    assert "HornScribe/README-portable.txt" in names
    # The staging README is repo-internal, not shipped.
    assert "HornScribe/tools/README.txt" not in names

    report = json.loads((out / "portable-size-report.json").read_text("utf-8"))
    assert report["version"] == "9.9.9"
    assert report["zip"] == zip_path.name
    assert report["components"]["HornScribe.exe"] == len(b"MZ-fake-shell")
    assert report["payloadBytes"] > 0 and report["zipBytes"] > 0

    # Portable marker semantics: data/ must exist (as the README holder).
    assert (out / "portable" / "HornScribe" / "data" / "README.txt").is_file()


def test_missing_shell_exe_fails(tmp_path: Path, stage_inputs):
    mod = _load_module()
    _, engine, tools = stage_inputs
    rc = _run(
        mod,
        [
            "--shell-exe", str(tmp_path / "nope.exe"),
            "--engine-exe", str(engine),
            "--tools-dir", str(tools),
            "--out", str(tmp_path / "o"),
            "--skip-smoke",
        ],
    )
    assert rc == 2


def test_missing_ffmpeg_fails(tmp_path: Path, stage_inputs):
    mod = _load_module()
    shell, engine, _ = stage_inputs
    empty = tmp_path / "empty-tools"
    empty.mkdir()
    rc = _run(
        mod,
        [
            "--shell-exe", str(shell),
            "--engine-exe", str(engine),
            "--tools-dir", str(empty),
            "--out", str(tmp_path / "o"),
            "--skip-smoke",
        ],
    )
    assert rc == 2
