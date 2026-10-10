## pitch_spelling_ambiguous が定義済みだが一度も発行されない(デッド仕様)

### 現状
- domain/review.py に ReviewReason.PITCH_SPELLING_AMBIGUOUS が定義済み。
- clean.py の docstring も「pitch spelling は下流で
  pitch_spelling_ambiguous issue として旗を立てる、黙って推測しない」
  と約束している。
- UI 側も ja.ts に日本語コピー(pitch_spelling_ambiguous)と
  score/review.ts の reason 型が揃っている。

**しかしエンジン内でこの reason を発行している箇所が 1 つもない。**
rg PITCH_SPELLING_AMBIGUOUS は定義と docstring にしかヒットしない。

### 期待
調外音(chromatic)で異名同音が複数あり得る音符に対して
pitch_spelling_ambiguous issue を発行し、レビュー UI で確認できる
ようにする。発行しすぎを防ぐため、ピッチクラスごとに 1 件・上限付き・
severity INFO を想定。調に沿ったスペリング実装(#165)とセットで
「正しいデフォルト + 曖昧な箇所だけレビューに出す」形にする。

### 代替案
発行しない方針に決めるなら、enum・コピー・docstring を整理して
デッドコードを消す(ただしレビュー駆動の設計思想とは整合しない)。
