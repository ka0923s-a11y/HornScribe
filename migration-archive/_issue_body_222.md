## 問題

`low_lead_level`（主旋律埋没の注意喚起、#191）の案内文が常に「分離品質：高精度での再採譲」を勧めるが、実際にはその選択肢にたどり着けないケースがある：

1. **demucs 未導入**（アドオンなし = 既定の配布構成）: 「分離品質」セレクト自体が無効化される（`vocalIsolationQualityNoDemucs`）ため、案内が dead-end になる。本当の処置は「設定→ツールからアドオンを導入」。
2. **既に precision ティアで実行済み**: 同じ再採譲を勧めても改善しない。正直な案内は「耳での確認・手動補正」。
3. **center_extraction での実行時に remedy ボタンなし**: demucs 標準ティアで実行済みなら、高精度ティアでのワンクリック再採譲（`retranscribeVocalIsolation` ハンドラが precision を固定）が有効なのに提示されていない。

## やること

- エンジン（pipeline.py）: `low_lead_level` の evidence に `tier`（要求ティア）/ `demucsAvailable` / `suggestPrecisionIsolation` を追加。
- UI（ScoreReadyWorkspace.tsx）: `reasonDetail` に `low_lead_level` 分岐を追加 — ratioDb の数値を明示し、method+tier+demucsAvailable から実際に到達可能な処置だけを案内する（アドオン導入 / 高精度再採譲 / 耳確認）。
- UI（reviewActions.ts）: `suggestPrecisionIsolation === true` のとき remedy ボタン「高精度分離で採譜し直す」（既存 `retranscribeVocalIsolation` ハンドラ再利用）。
- 後方互換: 旧エンジンで生成したプロジェクト（新 evidence キーなし）は従来の静的コピーにフォールバック。

関連: #165（SNR下限の記録、本 issue はそのUX面）, #191, #181, #314
