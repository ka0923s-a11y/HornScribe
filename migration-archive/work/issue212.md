## 問題

`possible_triplet` issue は「この区間は三連符らしいが二分割で書いた」と検出するが、レビュー UI に「三連符に直す」アクションがない。requantize は全曲対象で、区間を指定して三連符を強制する手段は存在しない。

## 方針

新しい score.edit 種別 `applyTriplet` を追加:

- issue evidence の `beatStartQl` で指定された区間を強制 TripletRegion として realizer に渡し、その区間を含む小節を再タイル
- 複合拍子（6/8 等）や区間外の音符は拒否
- desktop: possible_triplet issue のアクションボタン「三連符に直す」→ applyTriplet、成功時 fixed

## 受け入れ条件

- possible_triplet 区間の音符が三連符 atom で再記譜される
- 区間外の音符・小節構造は不変
- undo/redo が動く
