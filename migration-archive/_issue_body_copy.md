## 問題

レビュー issue の案内文が実際の UI 画面・実行方式とずれている箇所がある：

1. **`accompaniment_part`**: 「不要なら**設定**の「伴奏も別パートで採譜する」を外せます」と案内するが、そのチェックボックスは採譜オプション（`TranscriptionOptionsDialog` / 取込時オプション）にあり、設定画面には存在しない。ユーザーが設定を探しても見つからない。
2. **`vocal_isolation_applied`**: 「中央定位のボーカル成分を推定してから採譜しています」と固定だが、demucs アドオン導入時は `method="demucs"`（ニューラル分離）で実行される。実行方式の記述が事実と異なる — evidence の `stage` で分岐すべき。

## やること

- `accompaniment_part` 詳細文を「採譜オプションの…」に修正。
- `reasonDetail` に `vocal_isolation_applied` の stage 分岐を追加 — `stage=="demucs"` なら demucs 由来の文言（`ja.reviewEvidence.vocalIsolationDemucs` 新設）、それ以外は現行文言。

関連: #187（分離の適用通知）, #212（伴奏パート）, #222（同種の案内修正）
