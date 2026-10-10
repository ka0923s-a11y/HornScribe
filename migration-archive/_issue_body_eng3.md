## 提案

frozen engine を PyInstaller `--onefile` → `--onedir` に変更する。

### 背景

onefile は毎起動時に ~290MB を `%TEMP%\\_MEI*` へ自己解凍する（実測 ~38s/高負荷時 50s+）。これが複数の実害の根本原因：

- **コールドスタートが handshake タイムアウトを超過**（別 issue — 低速環境で起動不能に見える）
- AV/Defender が解凍ごとに全 DLL を再スキャン → 起動をさらに遅延
- 親子 2 プロセス構造 → `child.kill()` が実体に届かず孤児化（別 issue）

onedir はブートローダーが同プロセス内で Python を起動するため：

- 解凍なし → 起動 ~3-8s 程度に短縮
- 単一プロセス → `kill()` が実体を確実に終了
- AV スキャンはインストール時の一度だけ

### 変更箇所

- `scripts/build_engine.py` — `--onedir` + 出力レイアウト
- `apps/desktop/src-tauri/tauri.bundled.json` — resources マッピング
- `engine.rs::bundled_engine_paths` — `engine/hornscribe-engine/hornscribe-engine.exe` の探索
- `scripts/package_portable.py` — ディレクトリごとステージング
- `scripts/release.py` / `scripts/smoke_engine.py` — exe パス解決

### 懸念

- 展開後のファイル数が増える（~数百ファイル）。NSIS/zip ともディレクトリ同梱は問題なし
