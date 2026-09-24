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

## Size estimate

onefile PyInstaller + ONNX model + onnxruntime + numpy/scipy lands
around 150-250 MB, the cost of fully-offline free-tier inference.
Alternatives (one-dir layout, first-run model download) are noted on
issue #83.
