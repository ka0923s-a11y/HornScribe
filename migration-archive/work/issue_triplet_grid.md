## 種別: 精度（リズム量子化）

triplets=AUTO（デフォルト）で、純粋な8分3連列が16分グリッドに
量子化される。bench 実測: `triplets-4-4` で全24音検出だが
medianOnsetErrMs=41.7（166.7msの3連位置が125msの16分位置に記譜）。
`swing-4-4` も裏の音が約+83msずれて直線8分に記譜され、
swingFeel も立たない。

## 影響

3連符系のパッセージが全部16分の奇妙なシンコペーションとして記譜
される — 見た目の楽譜としては読めない譜レベル。JPOP・バラード・
シャッフル系で頻出。

## 方向性

- region-gated triplet detection の発火条件を検証: 全音符が3連位相に
  乗る区間でも発火しない経路があるはず
- swing 2:1 パターンは swingFeel メタ + 等分8分記譜、または3連
  記譜のどちらかに必ず倒すべき（現状は直線8分で誤位置）

関連: QUANTIZER_DESIGN triplet regions / detect_swing
