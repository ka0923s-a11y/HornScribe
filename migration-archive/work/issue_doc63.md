## 種別: 仕様不整合（ドキュメント）

PR #79 でアライメント推定が「記譜可能ラティス残留 + 拍節強度タイブレーク」方式に変わったが、以下の設計文書が旧契約のまま残っている:

- docs/QUANTIZER_DESIGN.md §6.3: 「複数peakの場合は自動適用せずReviewIssue」とだけ書かれ、union lattice（16分 ∪ 拍/3）による残留計算、競合極小の拡大収集（ALIGNMENT_TIEBREAK_PER_WEIGHT）、階層強度カーネル（beat>eighth>third）、meter_resolved フラグ、band-edge の保守的フォールバックが記述されていない
- docs/QUANTIZER_WEIGHTS_V1.md: 「Alignment search flags beat_alignment_uncertain on latency/jitter」— 解消可能な曖昧さは今やフラグではなく適用される

実装（python/hornscribe/rhythm/quantizer.py 内の詳細コメント群）と設計書を一致させる。新しい定数（EPS/MARGIN/EVIDENCE/TIEBREAK_PER_WEIGHT, 階層ウェイト）の意味と選択理由も併せて残す。
