## 機能候補

`quantize_events` は k-best の代替解釈を返し、rank-1/rank-2 で記譜が異なる区間は `quantization_ambiguous` の review issue になる。しかし UI 側に「代替解釈を適用する」手段がない — issue は「曖昧です」と伝えるだけで、ユーザーは accept/dismiss するか音符を手編集するしかない。

## 提案

quantization_ambiguous issue に代替案の適用アクションを付ける:

- engine: job.result に代替解釈のランク2を保持（または score.edit に applyAlternative 系を追加）し、その区間だけ rank-2 の記譜に差し替える
- desktop: issue のアクションボタンで「別の解釈に切り替え」を提示、適用時に該当区間の音符を差し替え + issue を fixed に

## 検討事項

- 代替案は区間単位ではなくパス全体のランキングなので、区間単位の差し替えには再量子化か差分マージが必要
- undo スタックとの整合
