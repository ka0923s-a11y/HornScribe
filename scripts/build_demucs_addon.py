#!/usr/bin/env python3
r"""Build the optional demucs separation addon for packaged apps (#190).

Produces ``dist/HornScribe-demucs-addon-<demucs version>-win64.zip``
containing a PyInstaller ONEDIR bundle::

    demucs/demucs.exe        (console entry -> demucs.separate:main)
    demucs/_internal/        (torch-cpu, numpy, soundfile, ...)
    README-demucs-addon.txt

The user extracts the zip into the app's writable addon drop-in --
``<data>/tools/`` (portable: ``HornScribe/data/tools``, installed:
``%APPDATA%/HornScribe/tools``). The shell prepends that dir to the
engine child's PATH and ``vocal._demucs_cmd`` resolves the nested
``<tools>/demucs/demucs.exe`` layout, so no config file or PATH edit
is needed -- extraction + engine restart is the whole install.

Why a separate zip instead of bundling into the app: the demucs stack
carries ~500-800 MB of torch-cpu for a feature most sessions never
touch. An opt-in addon keeps the base download small while staying
fully free (torch CPU wheels + demucs 4.x + PyInstaller -- no CUDA,
no paid services). Model weights still download once on first use
(~80 MB standard / ~300 MB precision) into the torch hub cache, since
repacking upstream checkpoints is out of scope for the installer.

Run inside the addon venv -- ``.venv-bp312`` (demucs + torch-cpu +
PyInstaller, deliberately WITHOUT torchaudio so soundfile handles
WAV I/O and the bundle stays leaner)::

    .venv-bp312\Scripts\python.exe scripts\build_demucs_addon.py

Then publish with ``gh release upload <tag> dist\<zip>`` -- the addon
is app-version independent (the contract is the folder layout, not
the app release).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORK_DIR = REPO / ".work" / "demucs-addon"
DIST_DIR = REPO / "dist"
ENTRY = REPO / "scripts" / "demucs_addon_entry.py"

# Train-time / legacy-model / dev-env paths -- not reachable from
# ``demucs.separate``, and they are what pulls numba/scipy/matplotlib
# into a venv that happens to carry the full engine stack.
_EXCLUDE_MODULES: tuple[str, ...] = (
    "demucs.repitch",
    "demucs.evaluate",
    "demucs.solver",
    "demucs.train",
    "demucs.grids",
    "numba",
    "llvmlite",
    "resampy",
    "mir_eval",
    "scipy",
    "matplotlib",
    "librosa",
    "basic_pitch",
    "music21",
    "onnxruntime",
     "sympy",
     "networkx",
     "torch.utils.tensorboard",
    # NOT torch.distributed: torch.utils.__init__ eagerly imports
    # torch.utils.data -> dataloader.py -> torch.distributed (2.14).
    # NOT torch.testing: torch.autograd.__init__ eagerly imports
    # autograd.gradcheck -> torch.testing (both proven by smoke).
)


README_TEXT = """HornScribe bunri kyouka addon -- see below

== HornScribe 分離強化アドオン (demucs) ==

このフォルダを丸ごと HornScribe の「アドオンの場所」に展開してください。

手順:
  1. HornScribe を起動し、設定 -> ツール を開きます
  2. 「アドオンの場所」の「フォルダを開く」を押します
  3. この zip の中身(demucs フォルダ)をそこへ展開します
     展開後、次のような配置になっていればOKです:
       <アドオンの場所>/demucs/demucs.exe
       <アドオンの場所>/demucs/_internal/...
  4. 設定 -> ツール の「エンジンを再起動」を押します
     (アプリ自体の再起動でも構いません)
  5. demucs が「検出済み」になれば導入完了です

以後、採譜オプションで「ボーカル分離」を有効にすると、
標準方式より高精度な demucs による分離が使われます。

* 初回利用時に分離モデル(約80-300MB)が自動でダウンロードされます。
  ダウンロードは1回だけで、以後はオフラインで動作します。
* アンインストールは demucs フォルダを削除するだけです。
"""


def _die(msg: str) -> int:
    print(f"addon: error: {msg}", file=sys.stderr)
    return 2


def _demucs_version() -> str:
    import demucs  # noqa: PLC0415 -- deferred; checked after env gate

    return demucs.__version__


def _run_pyinstaller(stage: Path) -> Path:
    """Freeze demucs into ``stage/demucs/`` (onedir layout)."""
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--console",
        "--name",
        "demucs",
        "--distpath",
        str(stage),
        "--workpath",
        str(WORK_DIR / "build"),
        "--specpath",
        str(WORK_DIR),
       # demucs needs its data: remote/*.yaml model manifests + the
       # lazily-imported submodules (separate -> apply -> pretrained
       # -> htdemucs/transformer chain).
        "--collect-all",
        "demucs",
        # torch needs its lib/*.dll payload only -- eager-mode demucs
        # never reaches dynamo/inductor/distributed, so a submodule
        # sweep would just drag sympy/networkx/jinja2 into the zip.
        "--collect-binaries",
        "torch",
        # demucs 4.x does its audio I/O through sphn (Rust ext) and
        # lameenc -- soundfile is only used by our own smoke-input
        # wav writer below, so nothing collects it into the bundle.
        "--collect-all",
        "numpy",
        *(
            flag
            for mod in _EXCLUDE_MODULES
            for flag in ("--exclude-module", mod)
        ),
        "--hidden-import",
        "einops",
        "--hidden-import",
        "julius",
        "--hidden-import",
        "lameenc",
        "--hidden-import",
        "yaml",
        # sphn is demucs 4.x's Rust audio reader -- top-level in api.py.
        "--hidden-import",
        "sphn",
        str(ENTRY),
    ]
    print(" ".join(args), flush=True)
    result = subprocess.run(args, cwd=REPO)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    exe = stage / "demucs" / (
        "demucs.exe" if sys.platform == "win32" else "demucs"
    )
    if not exe.is_file():
        raise SystemExit(_die(f"expected output missing: {exe}"))
    return exe


def _smoke(exe: Path, full: bool) -> None:
    """Gate the zip on a runnable bundle, not just a produced one."""
    for args, label in (
        (["--help"], "help"),
        (["--list-models"], "list-models"),
    ):
        print(f"addon: smoke: {label}", flush=True)
        r = subprocess.run(
            [str(exe), *args],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode != 0:
            raise SystemExit(
                _die(
                    f"smoke {label} failed (rc={r.returncode}): "
                    f"{r.stderr[-500:]}"
                )
            )
    if not full:
        return
    # Full separation smoke -- exercises torch matmul + soundfile I/O,
    # the parts --help never touches. Downloads htdemucs once into the
    # dev torch cache if absent (~80 MB, same as the user experience).
    print("addon: smoke: separating a 1s tone with htdemucs", flush=True)
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "tone.wav"
        t = np.linspace(0, 1, 44100, endpoint=False)
        sig = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        sf.write(str(wav), np.stack([sig, sig], axis=1), 44100)
        r = subprocess.run(
            [
                str(exe),
                "-n",
                "htdemucs",
                "--two-stems=vocals",
                "-o",
                td,
                str(wav),
            ],
            capture_output=True,
            text=True,
            timeout=900,
        )
        out = Path(td) / "htdemucs" / "tone" / "vocals.wav"
        if r.returncode != 0 or not out.is_file():
            raise SystemExit(
                _die(
                    f"smoke separation failed (rc={r.returncode}): "
                    f"{r.stderr[-500:]}"
                )
            )
    print("addon: smoke: separation OK", flush=True)


def _package(exe: Path, version: str) -> Path:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    zpath = DIST_DIR / f"HornScribe-demucs-addon-{version}-win64.zip"
    root = exe.parent  # <stage>/demucs
    # README sits at the ZIP ROOT so the user sees the install steps
    # before extracting; inside demucs/ it would be buried.
    readme = root.parent / "README-demucs-addon.txt"
    readme.write_text(
        README_TEXT,
        encoding="utf-8",
    )
    print(f"addon: zipping {root} -> {zpath}", flush=True)
    with zipfile.ZipFile(
        zpath,
        "w",
        zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as zf:
        for path in sorted(root.rglob("*")):
            # Skip a README left inside demucs/ by an older run --
            # the canonical copy goes to the zip root below.
            if path.is_file() and path.name != readme.name:
                zf.write(path, path.relative_to(root.parent))
        zf.write(readme, readme.name)
    return zpath


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--skip-smoke",
        action="store_true",
        help="build the zip without running the frozen binary",
    )
    ap.add_argument(
        "--no-full-smoke",
        action="store_true",
        help="run --help/--list-models only; skip the real separation",
    )
    args = ap.parse_args()

    if sys.platform != "win32":
        return _die("the addon is Windows-only (the app is win64)")
    try:
        import PyInstaller  # noqa: F401, PLC0415
    except ImportError:
        return _die("pyinstaller is required: pip install pyinstaller")
    try:
        version = _demucs_version()
    except ImportError:
        return _die(
            "demucs is not installed in this interpreter -- run the "
            "script from the addon venv (.venv-bp312)"
        )
    import torch  # noqa: PLC0415

    if torch.cuda.is_available():
        print(
            "addon: note: this torch has CUDA; the release addon is "
            "meant to use the +cpu wheel",
            flush=True,
        )

    stage = WORK_DIR / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    exe = _run_pyinstaller(stage)
    total = sum(
        p.stat().st_size for p in exe.parent.rglob("*") if p.is_file()
    )
    print(f"addon: bundled demucs: {exe} ({total / 1e6:.0f} MB unpacked)")

    if not args.skip_smoke:
        _smoke(exe, full=not args.no_full_smoke)

    zpath = _package(exe, version)
    print(f"addon: done: {zpath} ({zpath.stat().st_size / 1e6:.0f} MB)")
    print("addon: publish: gh release upload <tag> " + zpath.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
