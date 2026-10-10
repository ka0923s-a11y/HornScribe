## 症状

v0.2.8 の `HornScribe_0.2.8_x64-setup.exe` (NSIS) が約 63MB で、エンジンが同梱されていない（正常時は ~370MB）。インストールすると採譜エンジンが起動できず採譜不可。

portable zip (394MB) は正常。

## 原因

#186 でエンジンを PyInstaller `--onedir` 化した際、`apps/desktop/src-tauri/tauri.bundled.json` の resources 指定が:

```json
"resources/engine/*": "engine/"
```

のまま残った。tauri-utils の resources 解決（glob モード）は `entry.is_dir()` をスキップするため、`resources/engine/hornscribe-engine/` ディレクトリに glob がマッチしても中身が再帰コピーされず、NSIS リソースに丸ごと漏れた。

portable zip は package_portable.py が独自に丸ごとコピーするため無傷だった。

## 対応

1. `tauri.bundled.json` を `"resources/engine": "engine/"`（ディレクトリ指定 → Walk モードで再帰コピー、構造保持）に修正。
2. release.py に NSIS アセットの内容検証を追加 — 今回の漏れは「setup.exe が作られた=成功」としか検査していなかったために通過した。7z 等で `engine/hornscribe-engine/hornscribe-engine.exe` の存在を検査するか、最低サイズ閾値で検知する。
3. v0.2.8 の壊れた setup アセットを差し替え or リリース注記で使用不可を明記し v0.2.9 を出す。
