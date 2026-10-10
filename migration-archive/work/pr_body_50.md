## Summary

issue #10/#11 の本体実装。外部ツール解決を一本化し、ポータブル配置を実装した。

### tools.rs(新規) — 一本化された解決順
- `resolve_ffmpeg`: 明示オーバーライド(設定→ツール / `ffmpeg_path` 引数) → `HORNSCRIBE_FFMPEG` → 同梱 `tools/ffmpeg.exe`(resource_dir / resources/ / exe dir)→ PATH
- `data_dir`: `HORNSCRIBE_DATA_DIR` → exe 隣 `data/`(ポータブル印)→ OS app-data。録音・sources・source-refs・cache・autosave・logs の全書き込み先を集約
- `which_exists` / `bundled_roots` を共通化(export.rs・engine.rs の重複を削除)

### ffmpeg の仕様不整合を修正
- `audio_probe` に `ffmpeg_path` 引数を追加 — 設定画面の FFmpeg パス指定が取り込み(プローブ/FLAC 正規化)にも効くようになった(従来は書き出し側だけが参照し、取り込みは PATH しか見ていなかった)
- `detect_tools` が同じ解決順を使うため、診断の「検出済み」と実行時の実態が常に一致する。無効な明示パスは静かにフォールバックせず missing になる(設定バッジと一致)

### エンジン子プロセスへの PATH 注入
- `engine_spawn` が同梱 `tools/` を子プロセス PATH 先頭に追加 → Python 側 audioread/demucs が同じ ffmpeg を見る

### ハンドシェイク + 診断表示
- worker capabilities に `demucsAvailable` / `ffmpegAvailable` を追加
- 診断情報シートに「demucs(ボーカル分離)」行を追加(エンジン応答時: 検出済み/見つかりません、未接続時: 不明)。コピー出力にも含まれる

### ポータブル(#11)
- `<exe>/data/` が置かれた配置では書き込み状態がすべて同梱dir内に収まる。RELEASE.md のポータブル zip 構成手順を engine/tools/data の3点に更新

## 検証
- vitest 805 pass(+1)、tsc/eslint クリーン
- pytest test_worker.py 47 pass(handshake が新 capability キーを返すことを検証)、ruff クリーン
- Rust はローカルに MSVC リンカが無く未コンパイル — レビュー + brace 検査のみ。`cargo check` はリリースビルド環境で要確認

## 残件
- ffmpeg static binary の実同梱は任意(配置すれば動く)。demucs の frozen 同梱は +1〜2GB のため engine-vocal extra として任意のまま
- 実機インストーラ/ポータブル zip での総合確認はリリース時(#11 の残タスクとして issue に記録済み)

Refs #10, refs #11
