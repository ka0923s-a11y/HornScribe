## 概要

スコア画面の波形選択バンドから「この区間を再採譜」を直接実行できる
ようにする (#57 / コード内の #345 フック)。

## 背景

#353 で波形の選択バンドは「再生/ナビゲーション状態」に分離され、
スコア画面のドラッグは transcriptionOptions を書き換えなくなった。
一方で `workspace/waveformSelection.ts` のコメントが明示する通り、
明示的な再採譜アクションを同じバンドにぶら下げることは当初からの
予定だった。#55 の採譜オプション dialog でも秒数の手打ちはできるが、
見えているバンドをそのまま使う方が圧倒的に速い。

## 変更内容

- **WaveformView**: 選択コンテキストアクション(ループ/再生/ズーム/解除)
  に 5 つ目のボタン「この区間を再採譜」を追加。`onRetranscribeSelection`
  prop を渡した画面にだけ出る(opt-in — 呼び出し側が可否を決める)。
- **App.tsx**: `snapshot.hasScore && !snapshot.isRecording` のときだけ
  コールバックを渡す。AUDIO_READY ではドラッグ自体が options.range
  =selection を書くので二重経路にしない。押下は
  `retranscribeWithOptions(overrides, commit)`(#343 の guarded
  transaction)経由で、`range:"selection"` + バンドの start/end を
  ジョブ override にし、stored options にも同内容を commit する。
- commit する判断: 明示的なボタン押下は「次の採譜し直すも同じ区間」の
  意思表示。採譜オプション dialog でも直前に走った区間が正直に見え、
  バンド解除 → optionsAfterWaveformClear で range が all に戻る既存
  挙動とも整合する。未保存の楽譜では従来どおり未保存確認が先に出て、
  キャンセルなら options は変わらない。
- **strings**: `ja.waveform.retranscribeSelection` = 「この区間を再採譜」
  (review.retranscribe と同じ表記)。

## 動作確認

- vitest +2(#57 describe): バンドあり+コールバックありでボタンが出て
  range を載せて発火すること、コールバック未提供では出ないこと
  (他の既存アクションは出続けること)を検証。
- tsc / eslint / copy テスト クリーン。

Closes #57
