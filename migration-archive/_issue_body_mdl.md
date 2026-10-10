## 問題

demucs 分離の初回実行時、モデル重み（標準約80MB / 高精度約300MB）が torch hub キャッシュへダウンロードされるが、`isolate_demucs_vocals` は `subprocess.run(capture_output=True, timeout=3600)` で完全ブロッキング——進捗イベントも出ないため、採譜中画面が数分間「固まった」ように見える（低速回線では10分超もあり得る）。キャンセルも外見上反応しない。

## やること

- **エンジン**: demucs 実行直前に torch hub の checkpoints ディレクトリを調べ、空/未作成なら `progress` イベントに `note="model_download"` を添える（`demucs_weights_pending()` を vocal.py に追加。TORCH_HOME 考慮、失敗時は沈黙）。
- **プロトコル/UI**: `JobEventPayload` は前方互換（index signature）のため追加フィールドは安全。`jobView` reducer に transient `note` フィールド（次のイベントで消える）を追加し、採譜中画面に「分離モデルをダウンロードしています（初回のみ）」を表示。
- note は stage 遷移・後続イベントでクリア（ダウンロード窓の間だけ表示）。

## 非目標

- ダウンロードの実測%（サブプロセスの出力ストリーミングは別 Issue の大掛かりさ）。
- モデル別キャッシュ個別判定（checkpoints 空判定の近似で十分 — 初回全体が本質）。
