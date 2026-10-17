"""#173: --toolchain auto falls back to gnu when link.exe is unusable."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "release", Path(__file__).parents[2] / "scripts" / "release.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def release(monkeypatch):
    """release module with toolchain install stubbed out.

    _ensure_gnu_toolchain is replaced by a no-op so resolver tests never
    invoke rustup; the original stays reachable as release._ensure_orig
    for the tests that exercise it.
    """
    mod = _load_module()
    mod._ensure_orig = mod._ensure_gnu_toolchain
    monkeypatch.setattr(mod, "_ensure_gnu_toolchain", lambda: None)
    return mod


def test_explicit_gnu_forces_gnu_env(release):
    env = release._resolve_rust_env("gnu")
    assert env == {
        "RUSTUP_TOOLCHAIN": release.GNU_TOOLCHAIN,
        "RUSTFLAGS": release.GNU_RUSTFLAGS,
    }


def test_auto_keeps_env_when_msvc_linkable(release, monkeypatch):
    monkeypatch.setattr(release, "_msvc_link_available", lambda: True)
    monkeypatch.setattr(
        release, "_rustc_host", lambda env: "x86_64-pc-windows-msvc"
    )
    assert release._resolve_rust_env("auto") == {}


def test_auto_falls_back_to_gnu_without_link_exe(release, monkeypatch):
    """The #173 incident: vswhere sees Build Tools but VC/Tools is empty,
    so link.exe is gone while the product still looks installed."""
    monkeypatch.setattr(release, "_msvc_link_available", lambda: False)
    monkeypatch.setattr(
        release, "_rustc_host", lambda env: "x86_64-pc-windows-msvc"
    )
    env = release._resolve_rust_env("auto")
    assert env["RUSTUP_TOOLCHAIN"] == release.GNU_TOOLCHAIN
    assert "rust-lld" in env["RUSTFLAGS"]


def test_auto_gnu_default_host_only_needs_rustflags(release, monkeypatch):
    """A machine whose default rustc is already gnu keeps its toolchain;
    we only force the rust-lld self-contained flags so the link does not
    depend on a system gcc (llvm-mingw cannot resolve -lgcc_eh)."""
    monkeypatch.setattr(release, "_msvc_link_available", lambda: False)
    monkeypatch.setattr(
        release, "_rustc_host", lambda env: "x86_64-pc-windows-gnu"
    )
    env = release._resolve_rust_env("auto")
    assert "RUSTUP_TOOLCHAIN" not in env
    assert env["RUSTFLAGS"] == release.GNU_RUSTFLAGS


def test_auto_gnu_default_host_wins_even_with_msvc(release, monkeypatch):
    """msvc tools present but user default is gnu -> respect the host,
    still harden the linker flags."""
    monkeypatch.setattr(release, "_msvc_link_available", lambda: True)
    monkeypatch.setattr(
        release, "_rustc_host", lambda env: "x86_64-pc-windows-gnu"
    )
    env = release._resolve_rust_env("auto")
    assert env == {"RUSTFLAGS": release.GNU_RUSTFLAGS}


def test_auto_unknown_host_falls_back(release, monkeypatch):
    """rustc host undetectable (rustc absent) -> gnu ensure path rather
    than an ambiguous inherit that dies inside cargo."""
    monkeypatch.setattr(release, "_msvc_link_available", lambda: False)
    monkeypatch.setattr(release, "_rustc_host", lambda env: "")
    env = release._resolve_rust_env("auto")
    assert env["RUSTUP_TOOLCHAIN"] == release.GNU_TOOLCHAIN


def test_ensure_gnu_toolchain_dies_without_rustup(release, monkeypatch):
    monkeypatch.setattr(release, "_gnu_toolchain_installed", lambda: False)
    monkeypatch.setattr(release.shutil, "which", lambda name: None)
    with pytest.raises(SystemExit):
        release._ensure_orig()


class TestDirtyEntries:
    """#343: porcelain parsing — tracked changes are the ones that
    can drift the shipped binaries away from the tag; untracked
    scratch files are counted, not listed."""

    def test_separates_tracked_from_untracked(self, release):
        tracked, untracked = release._dirty_entries(
            " M apps/desktop/src/App.tsx\n"
            "M  python/hornscribe/pipeline.py\n"
            "?? apps/desktop/_scratch.mjs\n"
            "?? _junk.txt\n"
            "A  docs/NEW.md\n"
        )
        assert tracked == [
            " M apps/desktop/src/App.tsx",
            "M  python/hornscribe/pipeline.py",
            "A  docs/NEW.md",
        ]
        assert untracked == 2

    def test_clean_tree(self, release):
        assert release._dirty_entries("") == ([], 0)
