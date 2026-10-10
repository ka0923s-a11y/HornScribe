## 完了記録 (PR #122)

**やったこと**:
- `scripts/package_portable.py` 新設: shell exe + 同梱 engine + tools(ffmpeg/ffprobe+LICENSE) + `data/` ポータブルマーカー + README を集めて zip 化。zip 化前に同梱エンジンを `smoke_engine.py` で疎通検証(壊れたバンドルを出荷前に検出)
- `tests/python/test_package_portable.py`: zip レイアウト・除外ルール・入力欠落時の失敗をカバー
- 同梱 ffmpeg を gyan.dev **essentials 9.0.2** に差し替え(full→essentials, mp3/m4a/flac/ogg/wma のデコードを検証済み): tools/ が ~454MB → ~211MB

**サイズ実測 (0.1.0, 2026-09-29)**:

| component | size |
|---|---:|
| HornScribe.exe | 24.2 MB |
| engine/hornscribe-engine.exe | 171.2 MB |
| tools/ffmpeg.exe | 105.4 MB |
| tools/ffprobe.exe | 105.2 MB |
| **payload total** | **~406 MB** |
| **portable zip (deflated)** | **~255 MB** |

**検証済み**: zip レイアウト(HornScribe/ 単一ルート)、ステージング済みエンジンの handshake+採譜 smoke、テスト 3 件。
**残検証(次回リリースビルド時)**: 新ビルドの exe でのポータブルモード実機確認 — ローカルの Rust toolchain に MSVC linker が無く `npx tauri build` 不可のため RELEASE.md §6 の手順に委譲(現行 exe は 9/22 ビルドで data/ マーカー判定 #50 より前)。

チェックリスト3項目(同梱解決パス設計・writable state 配置・サイズ計測記録)はすべてコード+ドキュメント+計測で完了。組立は `python scripts/package_portable.py` 一本に集約。
