# Packaging / bundled engine (#83)

HornScribe bundles a frozen Python engine so packaged builds transcribe
without a Python install. See scripts/build_engine.py.

## Engine resolution order (engine.rs)

- `HORNSCRIBE_ENGINE`: absolute path to a frozen binary
- `HORNSCRIBE_PYTHON`: interpreter override (dev/debug)
- bundled `engine/hornscribe-engine[.exe]`: resource dir / exe dir
- repo-local `.venv*` (dev checkouts)
- `python` / `py` on PATH

## Build the bundled engine

Run inside the engine venv (the one with hornscribe engine extras):

```bash
pip install pyinstaller
python scripts/build_engine.py
# -> apps/desktop/src-tauri/resources/engine/hornscribe-engine.exe
```

## Package with the engine

```bash
cd apps/desktop
npx tauri build --config src-tauri/tauri.bundled.json
```

`tauri.bundled.json` is a merge overlay that adds `resources/engine/*`
to `bundle.resources`. The base `tauri.conf.json` stays resource-free
so dev builds never fail on the missing binary.

## Bundled tools (ffmpeg) — #10

`tools.rs::resolve_ffmpeg` uses one order for every consumer (native
audio probe, FLAC transcode, `detect_tools` diagnostics):

- explicit override (設定 → ツール / `ffmpeg_path` arg)
- `HORNSCRIBE_FFMPEG` env var
- bundled `tools/ffmpeg[.exe]` — same roots as the engine:
  resource dir, its `resources/` child, and the exe dir
- PATH

To ship a static ffmpeg: place it at `resources/tools/ffmpeg.exe`, add
`"resources/tools/*": "tools/"` to `tauri.bundled.json`, or drop a
`tools/` folder beside the portable exe (no installer needed). The
engine child gets every bundled `tools/` dir prepended to PATH, so
Python-side audioread/demucs resolve the same binary.

An invalid explicit override resolves to "missing" (never silently
falls back), so the settings badge and runtime agree.

## Writable state & portable layout — #11

All writable state resolves through `tools::data_dir`:

- `HORNSCRIBE_DATA_DIR` (must be an existing directory)
- `data/` beside the executable — the portable-zip marker
- platform app-data dir (installed builds, unchanged)

This covers `recordings/`, `sources/`, `source-refs.json`, `cache/`
(incl. the FLAC normalization cache), `logs/` and the autosave file.
A portable zip that ships `data/` next to the exe keeps everything
self-contained — nothing touches %APPDATA%.

## demucs

demucs stays an engine-side extra (`pip install hornscribe[engine-vocal]`
in the engine venv before `build_engine.py` — PyInstaller then freezes
torch + demucs inside the engine binary, which roughly doubles its
size). The worker handshake reports `demucsAvailable`; the diagnostics
sheet shows it as the demucs(ボーカル分離) row.

## Size estimate

onefile PyInstaller + ONNX model + onnxruntime + numpy/scipy lands
around 150-250 MB, the cost of fully-offline free-tier inference.
A bundled static ffmpeg adds ~30-80 MB; demucs (torch) inside the
frozen engine adds roughly 1-2 GB — the engine-vocal extra is optional
for exactly this reason. Alternatives (one-dir layout, first-run model
download) are noted on issue #83.
