# ローカル完結リリース手順 (#2 / #137)

> **正規経路は `scripts/release.py`** — このドキュメントの各ステップを
> そのまま自動化したもの(`python scripts/release.py` 一発で検証・
> ビルド・検査・公開まで実行)。ここに書かれているのは個別ステップを
> 手動で回したい場合の内訳。手順の概要と前提は `docs/RELEASING.md`。

本リポジトリは GitHub Actions を使わない。検証・ビルド・タグ付け・Release 公開のすべてをローカルで行う。対象成果物は NSIS インストーラとポータブル zip(構成は手動)。

## 前提

- Windows + MSVC ビルドツール(`cargo tauri build` がリンクに必要)
- Node.js + npm(`apps/desktop` のビルド・検証)
- Rust toolchain(rustup + tauri-cli)
- Python 3.11+ — 検証用 `.venv` と、engine extras 入りの `.venv-bp312`(frozen engine 生成に必要)
- PyInstaller(`build_engine.py` 実行 venv にインストール)
- `gh` CLI ログイン済み(Release 作成/アップロード)

## 1. 検証ゲート(全パス必須)

```powershell
# apps/desktop
cd apps/desktop
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src
node node_modules/vitest/vitest.mjs run

# python
cd ../..
.venv/Scripts/python.exe -X utf8 -m pytest tests/python -x -q
.venv/Scripts/python.exe -m ruff check python/hornscribe tests/python

# engine smoke(実エンジン疎通)
```

必要に応じて `scripts/bench_engine_runtime.py` / `scripts/bench_quantizer.py` で性能回帰も記録する。

## 2. bundled engine 生成

```powershell
# engine extras 入り venv で
pip install pyinstaller
python scripts/build_engine.py
# -> apps/desktop/src-tauri/resources/engine/hornscribe-engine.exe
```

frozen binary を直接疎通させる(worker NDJSON プロトコルの smoke
test — ONNX モデル/librosa 同梱漏れをここで検出):

```powershell
python scripts/smoke_engine.py apps/desktop/src-tauri/resources/engine/hornscribe-engine.exe
```

詳細は `docs/PACKAGING.md`(engine 解決順・サイズ見積もり)。

## 3. アプリビルド(NSIS インストーラ)

```powershell
cd apps/desktop
npx tauri build --config src-tauri/tauri.bundled.json
# -> src-tauri/target/release/bundle/nsis/HornScribe_*-setup.exe
```

`tauri.bundled.json` は `resources/engine/*` を同梱するマージオーバーレイ。ベース `tauri.conf.json` はリソース無し(開発ビルドを壊さないため)。

## 4. ポータブル zip(手動構成)

ポータブル zip は `scripts/package_portable.py` が構成する:

```powershell
python scripts/package_portable.py
# -> dist/HornScribe-<version>-portable-win-x64.zip
#    + dist/portable-size-report.{md,json} (計測サイズ記録)
```

shell exe(既定 `src-tauri/target/release/hornscribe-desktop.exe`,
`--shell-exe` で差し替え可)・`resources/engine/`・`resources/tools/`
を集め、`data/` マーカーと `README-portable.txt` を追加して zip 化する。
zip 化前に同梱エンジンを `smoke_engine.py` で疎通検証する
(`--skip-smoke` で省略可)。

exe の隣に `engine/` `tools/` `data/` を置けば、`tools.rs`/`engine.rs` の解決順(exe dir)で同梱エンジン・ffmpeg・ポータブルデータ配置がすべて有効になる(#10/#11)。`data/` を置かない従来配置は従来どおり %APPDATA% ベースで動く。

## 5. タグと Release 公開(手動)

```powershell
git tag -a vX.Y.Z -m "HornScribe vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z `
  apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe `
  dist/HornScribe-portable.zip `
  --title "HornScribe vX.Y.Z" `
  --notes-file RELEASE_NOTES.md
```

- `gh release` が使えない環境では GitHub Web UI の Releases → Draft a new release でタグ選択 + 成果物ドラッグでもよい(方針上「アップロードは手動」)
- リリースノートは変更点の日本語要約 + 検証ゲート結果 + 成果物サイズ(実行ファイル・zip の MB)を記録する

## 6. リリース後確認

- クリーン環境(別マシンまたは新規ユーザー)でインストール → 起動 → `smoke_engine.py` 相当の採譜疎通
- ポータブル zip 解凍 → exe 直起動 → 同梱 engine 解決の確認
 - 同梱 ffmpeg を置いた場合は診断画面の FFmpeg 行が同梱パスを指すこと、demucs 同梱時は demucs(ボーカル分離)行が「検出済み」になることを確認(#10)
