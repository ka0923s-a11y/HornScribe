## HornScribe — プレビューリリース

Windows向けデスクトップアプリ（Tauri 2 + React + Verovio）。日本語UIのみ。オフライン動作。

### ファイル

- `*-setup.exe` — NSISインストーラー
- `*-portable.zip` — インストール不要のポータブル版（展開して `hornscribe-desktop.exe` を実行）

### 要件

- Windows 10/11 x64 + WebView2ランタイム（Windows 11は標準搭載）
- PDF書き出しには別途 MuseScore Studio が必要（未検出時はPDFのみ無効化）

### 同梱物

- 採譜エンジン（Basic Pitch ONNX）を同梱 — Python 不要でオフライン採譜が動きます

### 既知の制限

- コード署名なし — SmartScreen警告が表示されます
- Narrator実機・200%スケーリング実機確認は手順のみ文書化（`docs/UI_070_VALIDATION_RESULTS.md`）
