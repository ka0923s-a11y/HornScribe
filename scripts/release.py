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

    1. preflight - version parity (package.json == tauri.conf.json),
       gh CLI present, no existing v<version> Release, tag sanity
    2. tests - tsc/eslint/vitest (apps/desktop), cargo check, pytest
    3. engine - scripts/build_engine.py inside the PyInstaller venv,
       then scripts/smoke_engine.py against the frozen binary
    4. bundle - npx tauri build --config <merged> where <merged> is
       tauri.bundled.json plus a WebView2Loader.dll resource whenever
       the gnu toolchain is in effect (#141 - gnu shells load it
       dynamically; MSVC links it statically and emits no DLL)
    5. portable - scripts/package_portable.py (stages + smoke + zip)
    6. verify - both assets exist, >=50 MB, zip contains the engine
       (and WebView2Loader.dll when the gnu toolchain emitted one)
    7. publish - tag v<version> (push), gh release create --prerelease

Flags worth knowing:

    --skip-tests / --skip-engine / --skip-tauri
        Reuse existing artifacts (e.g. re-publish after a failed upload).
    --toolchain {auto,gnu}
        gnu sets RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu and
        RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" for the
        cargo/tauri steps - needed on machines where only the gnu
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
# #186: the staged engine is a PyInstaller ONEDIR bundle — the exe nests
# under resources/engine/hornscribe-engine/ with its _internal/ dir.
ENGINE_EXE = (
    SRC_TAURI
    / "resources"
    / "engine"
    / "hornscribe-engine"
    / "hornscribe-engine.exe"
)
BUNDLED_CONF = SRC_TAURI / "tauri.bundled.json"
MERGED_CONF = SRC_TAURI / "target" / "tauri.release.merged.json"
WEBVIEW2_LOADER = SRC_TAURI / "target" / "release" / "WebView2Loader.dll"
NSIS_DIR = SRC_TAURI / "target" / "release" / "bundle" / "nsis"
RELEASE_NOTES = REPO / ".github" / "RELEASE_NOTES.md"
MIN_ASSET_BYTES = 50 * 1024 * 1024  # engine-bundled artifacts are >50 MB

# #193: the NSIS must carry the onedir engine — 7-Zip lists installer
# contents so the check is structural, not just "the exe is big".
_7Z_CANDIDATES = (
    "7z",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)

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
        "- pip install pyinstaller into the engine venv first"
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


def _seven_zip() -> str | None:
    for cand in _7Z_CANDIDATES:
        found = shutil.which(cand)
        if found:
            return found
    return None


def _verify_nsis_engine(setup: Path, need_loader: bool) -> None:
    """#193: "a setup.exe exists" is not "the engine shipped" — v0.2.8
    published a 63 MB installer because the `resources/engine/*` glob
    silently skipped the onedir directory while tools/ffmpeg alone
    already exceeded the 50 MB floor. Two checks: a floor derived from
    the staged resources size, and — when 7-Zip is available — a
    structural listing for the engine exe itself."""
    resources_bytes = sum(
        f.stat().st_size
        for f in (SRC_TAURI / "resources").rglob("*")
        if f.is_file()
    )
    floor = max(MIN_ASSET_BYTES, int(resources_bytes * 0.20))
    size = setup.stat().st_size
    if size < floor:
        raise _die(
            f"{setup.name} is only {size / 1e6:.1f} MB (< {floor / 1e6:.0f} MB"
            f" expected from {resources_bytes / 1e6:.0f} MB of resources)"
            " - engine bundle likely missing"
        )
    seven = _seven_zip()
    if seven is None:
        print(
            "note: 7-Zip not found - NSIS contents verified by size floor only"
        )
        return
    r = subprocess.run(
        [seven, "l", str(setup)],
        capture_output=True,
        text=True,
        errors="replace",
    )
    listing = r.stdout or ""
    if "hornscribe-engine.exe" not in listing:
        raise _die(
            f"{setup.name} does not contain"
            " engine/hornscribe-engine/hornscribe-engine.exe - the"
            " tauri.bundled.json resources mapping regressed (#193)"
        )
    if need_loader and "WebView2Loader.dll" not in listing:
        raise _die(
            f"{setup.name} does not contain WebView2Loader.dll -"
            " gnu-built shells crash without it next to the exe (#141)"
        )


def _rustc_host(env: dict[str, str]) -> str:
    """rustc host triple under the given env; "" when undetectable."""
    merged = None if not env else {**os.environ, **env}
    try:
        r = subprocess.run(
            [_resolve("rustc"), "-vV"], capture_output=True, text=True, env=merged
        )
    except OSError:
        return ""
    if r.returncode != 0:
        return ""
    for line in r.stdout.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    return ""


def _bundled_config(need_loader: bool) -> Path:
    """Bundle config for tauri build --config (#141).

    tauri.bundled.json stages engine/ + tools/ as install-root resources.
    gnu-built shells additionally need WebView2Loader.dll next to the
    exe; webview2-com-sys drops it into target/release during the cargo
    build, i.e. before the bundler resolves resources - so injecting the
    entry is safe even on a fresh target/ as long as the host triple is
    gnu. MSVC links the loader statically and never emits the file, so
    the entry is skipped there (a missing resource fails the build).
    """
    merged = json.loads(BUNDLED_CONF.read_text(encoding="utf-8"))
    if need_loader:
        merged.setdefault("bundle", {}).setdefault("resources", {})[
            "target/release/WebView2Loader.dll"
        ] = "WebView2Loader.dll"
    MERGED_CONF.parent.mkdir(parents=True, exist_ok=True)
    MERGED_CONF.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return MERGED_CONF


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

    # The cp932 console cannot encode characters like - in our own
    # messages; replacing beats a silent UnicodeEncodeError mid-release.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    # -- 1. preflight -------------------------------------------------------
    pkg_v, tauri_v = _versions()
    if pkg_v != tauri_v:
        raise _die(f"package.json {pkg_v} != tauri.conf.json {tauri_v}")
    version = pkg_v
    tag = f"v{version}"
    if shutil.which("gh") is None:
        raise _die("gh CLI not found on PATH")
    if _release_exists(tag):
        raise _die(f"GitHub Release {tag} already exists - bump version or delete it")
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
            "release: warning: HEAD != origin/main - the tag will point at a "
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
    host = _rustc_host(rust_env)
    need_loader = "gnu" in host or WEBVIEW2_LOADER.is_file()
    print(
        f"\nrustc host: {host or '(unknown)'} "
        f"- WebView2Loader.dll resource: {'on' if need_loader else 'off'}"
    )
    if not args.skip_tauri:
        _run(
            ["npx", "tauri", "build", "--config", str(_bundled_config(need_loader))],
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
                f"{asset.name} is only {size / 1e6:.1f} MB - engine bundle likely missing"
            )
    _verify_nsis_engine(setup_exe, need_loader)
    with zipfile.ZipFile(portable_zip) as zf:
        names = zf.namelist()
        if not any(
            "engine/hornscribe-engine/hornscribe-engine.exe" in n for n in names
        ):
            raise _die(
                f"{portable_zip.name} does not contain engine/hornscribe-engine/"
            )
        if need_loader and not any(n.endswith("/WebView2Loader.dll") for n in names):
            raise _die(
                f"{portable_zip.name} does not contain WebView2Loader.dll - "
                "gnu-built shells crash without it next to the exe (#141)"
            )
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
        # non-interactive fallback - curated notes file missing
        gh_args += ["--generate-notes"]
    _run(gh_args, cwd=REPO, what="gh release create")
    print(f"\nrelease {tag} published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
