## 概要

スコア画面で波形をドラッグして選んだ区間を、そのまま「この区間を再採譜」
できるようにする。コード上の #345 フックとして残っている未実装機能。

## 背景

- 波形の選択バンドは #353 で「再生/ナビゲーション用の状態」に分離された。
  スコア画面でドラッグしても transcriptionOptions.range は変わらない
  (暗黙の絞り込みを防ぐ所有権ルール)。
- ただしコードコメントが明記している通り、「明示的な『この区間を
  再採譜』アクションを同じバンドにぶら下げる」ことは当初から予定されて
  いた(`workspace/waveformSelection.ts` の #345 参照コメント)。
- #55 でスコア画面の採譜オプション dialog が入ったが、区間指定は
  秒数を手打ちするしかなく、波形上で見えているバンドをそのまま
  使えない。

## 提案

- 波形の選択コンテキストアクション(ループ/再生/ズーム/解除)に
  「この区間を再採譜」ボタンを追加する。
- 表示条件: スコア存在時(scoreReady/reviewing 等)かつ録音中でないこと。
  AUDIO_READY ではドラッグ自体が既に options.range=selection を
  書くので二重経路にしない。
- 押下時の挙動: `retranscribeWithOptions`(#343 guarded transaction)で
  `range:"selection"` + バンドの start/end をジョブ override し、
  同内容を stored options にも commit する。未保存の楽譜では
  「保存せずに続ける」確認が先に出る既存経路を踏む。
- commit する理由: 明示的なボタン押下は「次の採譜し直すも同じ区間」の
  意思表示と解釈でき、options dialog が開いたときにも直前に走った
  区間が正直に見える。バンドを解除すれば optionsAfterWaveformClear が
  range を all に戻す既存挙動と整合する。

## 受け入れ条件

- スコア画面で波形をドラッグ→「この区間を再採譜」→ 該当区間だけの
  ジョブが走る(settings echo に selectionStartSec/EndSec)。
- 未保存編集があるときは未保存確認が出て、キャンセルなら options も
  変化しない。
- AUDIO_READY ではボタンが出ない(既存のドラッグ→採譜を開始経路と
  重複させない)。
