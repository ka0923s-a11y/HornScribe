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

To ship a static ffmpeg: place it at `resources/tools/ffmpeg.exe`
(`ffprobe.exe` alongside feeds `doctor`/diagnostics) — the
`"resources/tools/*": "tools/"` mapping is pre-wired in
`tauri.bundled.json`, so the bundled build picks it up automatically
(see `resources/tools/README.txt`). For the portable zip, drop a
`tools/` folder beside the exe instead (no installer needed). The
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

The engine reaches demucs through `_demucs_cmd()` (vocal.py), in this
order:

- `HORNSCRIBE_DEMUCS` — explicit executable path (a bad path reports
  missing, never falls through)
- `sys.executable -m demucs` — dev installs only; a frozen engine
  skips this on purpose (the exe is the worker — `-m` would spawn a
  second worker on the protocol pipe)
- `demucs` console script on PATH — covers a bundled
  `tools/demucs.exe` (the dir is PATH-injected) and a user-side
  `pip install demucs`
- `HORNSCRIBE_PYTHON` / PATH `python`/`python3` with demucs importable
  — probed via `find_spec`, never by importing torch

So a user who runs `pip install demucs` into their own Python gets
neural vocal separation in the packaged app with zero extra config —
the free path stays intact. Shipping a frozen `demucs.exe` in tools/
is the fully-offline option (~1-2 GB with torch + model weights, so
it stays opt-in). The worker handshake reports `demucsAvailable` via
the same resolver; the diagnostics sheet shows it as the
demucs(ボーカル分離) row.

## Measured size (0.1.0, 2026-09-29)

From `dist/portable-size-report.md` (scripts/package_portable.py):

| component | size |
|---|---:|
| HornScribe.exe | 24.2 MB |
| engine/hornscribe-engine.exe | 171.2 MB |
| tools/ffmpeg.exe (gyan essentials 9.0.2) | 105.4 MB |
| tools/ffprobe.exe (gyan essentials 9.0.2) | 105.2 MB |
| **payload total** | **~406 MB** |
| **portable zip (deflated)** | **~255 MB** |

The frozen engine embeds basic-pitch ONNX + onnxruntime + numpy/scipy
-- the cost of fully-offline free-tier inference. ffmpeg is the
gyan.dev *essentials* build; the *full* build (~227 MB per binary)
roughly doubles the media-tool footprint without adding codecs the
app uses (decode -> PCM, WAV/FLAC transcode). A frozen demucs.exe
would add ~1-2 GB -- the demucs path stays opt-in for exactly this
reason. Alternatives (one-dir layout, first-run model download) are
noted on issue #83.
