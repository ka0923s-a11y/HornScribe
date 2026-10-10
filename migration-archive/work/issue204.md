## 問題

レビューワークスペースのアクションボタン（issue 固有のワンクリック修正）を実行しても、対象の issue が open のまま残る:

- `tempo_uncertain`: scaleTempo を適用しても issue は未解決のまま
- `pitch_spelling_ambiguous`: 異名同音トグルを実行しても issue は未解決のまま

ユーザーは「修正したのにまだ要確認と出る」状態になり、accept/dismiss の手動操作が余計に必要。音高修正や削除は `fixed` に遷移する設計なので、アクション系も同じにすべき。

## 方針

アクション成功後に `session.decide(issue.id, "fixed")` を呼ぶ（undo スタックに乗る）。undo は先に fixed を戻し、次にスコア編集を戻す順で自然に動く。

## 受け入れ条件

- tempo_uncertain の修正ボタン → issue が fixed になる
- pitch_spelling_ambiguous のトグル → issue が fixed になる
- undo で両方元に戻る
