## 種別: 計測基盤の拡張（精度向上の前提）

`scripts/bench_transcription_e2e.py` の4フィクスチャは全て1.0で飽和した。
「一般JPOPを完璧な楽譜にする」には弱点を可視化する難フィクスチャが必要。
現状のギャップ:

- 全フィクスチャが tempoBpm/meter をピン留め → 製品デフォルトの自動推定
  (tempo/meter estimation) が一切検証されていない
- texture="mono" 固定 → chords/voices 経路が未検証
- スコアリングが単一テンポ変換 → tempoMap 複数セグメント（変テンポ）を
  正しく採点できない

## 提案

Fixture に texture / ヒント有無を持たせ、以下を追加:

- `triplets-4-4` — 8分3連符（triplet検出）
- `sixteenths-4-4` — 16分連打（minDuration境界）
- `pickup-4-4` — 弱起（pickupBeats検出）
- `rests-4-4` — 音符・休符交互（merge/ghost規律）
- `swing-4-4` — スウィング8分（swingFeel判定）
- `mixed-divisions-4-4` — 4分+8分+3連+16分混合（実曲相当）
- `dyads-4-4` — 3度重音（texture=chords）
- `auto-4-4` / `auto-3-4` / `auto-6-8` — ヒント無し（tempo/meter推定）
- `tempo-step-4-4` — 途中でBPM変化（tempoMap採点、要piecewise変換）

スコアリング: `content.tempoMap` の複数セグメントをpiecewiseに
beats→sec変換。レポートに期待meter/tempo・meterOk・tempoRatioを追加。

失敗したフィクスチャは別issueで精度改善として追う（本issueは計測のみ）。
