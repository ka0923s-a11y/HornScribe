## 実機検証記録

v0.2.11 リリース資産 `HornScribe-demucs-addon-4.1.0-win64.zip` を検証：

- ビルド時 smoke: `--help` / `--list-models` / 1秒トーンの htdemucs 実分離 すべて通過
- 同梱エンジン exe に対し、アドオン展開先（`tools/demucs/demucs.exe` 配置）を PATH 注入して `engine.handshake` を実行 → **`demucsAvailable: true`** を確認（約3.2秒で応答）
- zip 直下が `demucs/` フォルダになっており、`_demucs_cmd()` のフォルダ形式プローブ（`<PATH dir>/demucs/demucs.exe`）と整合

実ユーザー手順（設定→ツール→アドオンの場所に展開→エンジン再起動）と等価の経路で検出を実証済み。
