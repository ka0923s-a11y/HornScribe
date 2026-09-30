#!/usr/bin/env python3
"""Local one-shot release for HornScribe (#137).

The documented release path used to assume a GitHub Actions workflow
(release.yml) that is not shipped in this repo, and Actions are not
allowed anyway. This script is the canonical replacement: it runs the
same steps the workflow described, entirely on the local machine.

    python scripts/release.py              # full pipeline + publish
    python scripts/release.py --dry-run    # build + verify, no tag/release
    python scripts/release.py --skip-tests # rebuild without test gate

Pipeline:

    1. preflight — version parity (package.json == tauri.conf.json),
       gh CLI present, no existing v<version> Release, tag sanity
    2. tests — tsc/eslint/vitest (apps/desktop), cargo check, pytest
    3. engine — scripts/build_engine.py inside the PyInstaller venv,
       then scripts/smoke_engine.py against the frozen binary
    4. bundle — npx tauri build --config src-tauri/tauri.bundled.json
       (NSIS installer; engine+tools staged by tauri.bundled.json)
    5. portable — scripts/package_portable.py (stages + smoke + zip)
    6. verify — both assets exist, >=50 MB, zip contains the engine
    7. publish — tag v<version> (push), gh release create --prerelease

Flags worth knowing:

    --skip-tests / --skip-engine / --skip-tauri
        Reuse existing artifacts (e.g. re-publish after a failed upload).
    --toolchain {auto,gnu}
        gnu sets RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu and
        RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" for the
        cargo/tauri steps — needed on machines where only the gnu
        toolchain works. auto (default) inherits the environment.
    --yes   Skip the interactive confirmation before publishing.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "apps" / "desktop"
SRC_TAURI = DESKTOP / "src-tauri"
PKG_JSON = DESKTOP / "package.json"
TAURI_CONF = SRC_TAURI / "tauri.conf.json"
ENGINE_EXE = SRC_TAURI / "resources" / "engine" / "hornscribe-engine.exe"
NSIS_DIR = SRC_TAURI / "target" / "release" / "bundle" / "nsis"
RELEASE_NOTES = REPO / ".github" / "RELEASE_NOTES.md"
MIN_ASSET_BYTES = 50 * 1024 * 1024  # engine-bundled artifacts are >50 MB

GNU_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
GNU_RUSTFLAGS = "-C linker=rust-lld -C link-self-contained=yes"


def _die(msg: str, code: int = 1) -> SystemExit:
    print(f"release: error: {msg}", file=sys.stderr)
    return SystemExit(code)


def _resolve(cmd0: str) -> str:
    # Windows: CreateProcess does not search PATHEXT, so "npm"/"npx"/"gh"
    # (npm-issued .cmd shims) raise FileNotFoundError unless resolved.
    return shutil.which(cmd0) or cmd0


def _run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    what: str,
) -> None:
    cmd = [_resolve(cmd[0]), *cmd[1:]]
    shown = " ".join(str(c) for c in cmd)
    print(f"\n=== {what} ===\n$ {shown}", flush=True)
    merged = None if env is None else {**os.environ, **env}
    r = subprocess.run(cmd, cwd=cwd or REPO, env=merged)
    if r.returncode != 0:
        raise _die(f"{what} failed (exit {r.returncode})")


def _out(cmd: list[str], *, cwd: Path | None = None) -> str:
    cmd = [_resolve(cmd[0]), *cmd[1:]]
    r = subprocess.run(cmd, cwd=cwd or REPO, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def _versions() -> tuple[str, str]:
    pkg = json.loads(PKG_JSON.read_text(encoding="utf-8")).get("version")
    tauri = json.loads(TAURI_CONF.read_text(encoding="utf-8")).get("version")
    return str(pkg), str(tauri)


def _venv_python() -> Path:
    """Engine build needs a venv with PyInstaller + hornscribe[engine]."""
    for cand in (REPO / ".venv-bp312", REPO / ".venv-bp311", REPO / ".venv"):
        py = cand / "Scripts" / "python.exe"
        if not py.is_file():
            continue
        r = subprocess.run(
            [str(py), "-c", "import PyInstaller"],
            capture_output=True,
        )
        if r.returncode == 0:
            return py
    raise _die(
        "no venv with PyInstaller found (tried .venv-bp312/.venv-bp311/.venv) "
        "— pip install pyinstaller into the engine venv first"
    )


def _test_venv() -> Path:
    for cand in (REPO / ".venv", REPO / ".venv-bp312"):
        py = cand / "Scripts" / "python.exe"
        if py.is_file():
            r = subprocess.run([str(py), "-c", "import pytest"], capture_output=True)
            if r.returncode == 0:
                return py
    raise _die("no venv with pytest found")


def _release_exists(tag: str) -> bool:
    r = subprocess.run(
        [_resolve("gh"), "release", "view", tag, "--json", "tagName"],
        cwd=REPO,
        capture_output=True,
    )
    return r.returncode == 0


def _find_nsis(version: str) -> Path:
    if not NSIS_DIR.is_dir():
        raise _die(f"no NSIS bundle dir: {NSIS_DIR}")
    exact = sorted(NSIS_DIR.glob(f"*{version}*setup.exe"))
    cands = exact or sorted(NSIS_DIR.glob("*setup.exe"), key=lambda p: p.stat().st_mtime)
    if not cands:
        raise _die(f"no *setup.exe under {NSIS_DIR}")
    return cands[-1]


def _find_portable(version: str) -> Path:
    dist = REPO / "dist"
    cands = sorted(dist.glob(f"HornScribe-{version}-portable-*.zip"))
    if not cands:
        cands = sorted(dist.glob("*portable*.zip"), key=lambda p: p.stat().st_mtime)
    if not cands:
        raise _die(f"no portable zip under {dist}")
    return cands[-1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skip-tests", action="store_true", help="skip the test gate")
    ap.add_argument("--skip-engine", action="store_true", help="reuse the staged engine exe")
    ap.add_argument("--skip-tauri", action="store_true", help="reuse the built NSIS bundle")
    ap.add_argument("--dry-run", action="store_true", help="stop before tag + gh release")
    ap.add_argument("--yes", "-y", action="store_true", help="skip publish confirmation")
    ap.add_argument(
        "--toolchain",
        choices=("auto", "gnu"),
        default="auto",
        help="rust toolchain for cargo/tauri steps (default: inherit env)",
    )
    args = ap.parse_args()

    if sys.platform != "win32":
        raise _die("the release path is Windows-only (NSIS + WebView2 shell)")

    # -- 1. preflight -------------------------------------------------------
    pkg_v, tauri_v = _versions()
    if pkg_v != tauri_v:
        raise _die(f"package.json {pkg_v} != tauri.conf.json {tauri_v}")
    version = pkg_v
    tag = f"v{version}"
    if shutil.which("gh") is None:
        raise _die("gh CLI not found on PATH")
    if _release_exists(tag):
        raise _die(f"GitHub Release {tag} already exists — bump version or delete it")
    tag_sha = _out(["git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}"])
    head = _out(["git", "rev-parse", "HEAD"])
    if tag_sha:
        tagged = _out(["git", "rev-list", "-n", "1", tag])
        if tagged and tagged != head:
            raise _die(f"tag {tag} already points at {tagged[:8]} != HEAD {head[:8]}")
    dirty = _out(["git", "status", "--porcelain", "--", "apps", "scripts", "docs", "python"])
    if dirty:
        print(f"release: warning: tracked changes under apps/scripts/docs/python:\n{dirty}")
    if head != _out(["git", "rev-parse", "--verify", "origin/main"]):
        print(
            "release: warning: HEAD != origin/main — the tag will point at a "
            "commit that is not on the pushed main branch"
        )

    rust_env: dict[str, str] = {}
    if args.toolchain == "gnu":
        rust_env = {
            "RUSTUP_TOOLCHAIN": GNU_TOOLCHAIN,
            "RUSTFLAGS": GNU_RUSTFLAGS,
        }

    # -- 2. tests -----------------------------------------------------------
    if not args.skip_tests:
        _run(["npm", "run", "typecheck"], cwd=DESKTOP, what="frontend typecheck")
        _run(["npm", "run", "lint"], cwd=DESKTOP, what="frontend lint")
        _run(["npm", "test"], cwd=DESKTOP, what="frontend vitest")
        _run(
            ["cargo", "check"],
            cwd=SRC_TAURI,
            env=rust_env or None,
            what="rust check",
        )
        _run(
            [str(_test_venv()), "-m", "pytest", "-x", "-q"],
            cwd=REPO,
            what="python engine tests",
        )

    # -- 3. engine ----------------------------------------------------------
    if not args.skip_engine:
        engine_py = _venv_python()
        _run(
            [str(engine_py), str(REPO / "scripts" / "build_engine.py")],
            cwd=REPO,
            what="frozen engine build (PyInstaller)",
        )
    if not ENGINE_EXE.is_file():
        raise _die(f"staged engine missing: {ENGINE_EXE}")
    _run(
        [sys.executable, str(REPO / "scripts" / "smoke_engine.py"), str(ENGINE_EXE)],
        cwd=REPO,
        what="engine smoke test",
    )

    # -- 4. tauri bundle ----------------------------------------------------
    if not args.skip_tauri:
        _run(
            ["npx", "tauri", "build", "--config", "src-tauri/tauri.bundled.json"],
            cwd=DESKTOP,
            env=rust_env or None,
            what="tauri build (NSIS installer)",
        )
    setup_exe = _find_nsis(version)
    print(f"\nnsis: {setup_exe}")

    # -- 5. portable zip -----------------------------------------------------
    _run(
        [sys.executable, str(REPO / "scripts" / "package_portable.py")],
        cwd=REPO,
        what="portable zip (staged + smoke + zip)",
    )
    portable_zip = _find_portable(version)

    # -- 6. verify -----------------------------------------------------------
    for asset in (setup_exe, portable_zip):
        size = asset.stat().st_size
        if size < MIN_ASSET_BYTES:
            raise _die(
                f"{asset.name} is only {size / 1e6:.1f} MB — engine bundle likely missing"
            )
    with zipfile.ZipFile(portable_zip) as zf:
        if not any("engine/hornscribe-engine.exe" in n for n in zf.namelist()):
            raise _die(f"{portable_zip.name} does not contain engine/hornscribe-engine.exe")
    print("\nassets verified:")
    for asset in (setup_exe, portable_zip):
        print(f"  {asset.name}  {asset.stat().st_size / 1e6:,.1f} MB")

    if args.dry_run:
        print("\n--dry-run: stopping before tag + GitHub Release")
        return 0

    # -- 7. publish ----------------------------------------------------------
    if not args.yes:
        try:
            ans = input(f"\npublish {tag} with these assets? [y/N] ").strip().lower()
        except EOFError:
            ans = ""
        if ans not in ("y", "yes"):
            print("aborted before publish")
            return 2
    if not tag_sha:
        _run(
            ["git", "tag", "-a", tag, "-m", f"HornScribe {tag}"],
            cwd=REPO,
            what=f"tag {tag}",
        )
    _run(["git", "push", "origin", f"refs/tags/{tag}"], cwd=REPO, what="push tag")
    gh_args = [
        "gh",
        "release",
        "create",
        tag,
        str(setup_exe),
        str(portable_zip),
        "--prerelease",
        "--title",
        f"HornScribe {tag}",
    ]
    if RELEASE_NOTES.is_file():
        gh_args += ["--notes-file", str(RELEASE_NOTES)]
    else:
        # non-interactive fallback — curated notes file missing
        gh_args += ["--generate-notes"]
    _run(gh_args, cwd=REPO, what="gh release create")
    print(f"\nrelease {tag} published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
