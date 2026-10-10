## 概要

録音中の採譜系アクションがコマンド登録(isEnabled: !isRecording)では
一貫して無効化されているが、コマンドを経由しない導線が残っている。

## 問題

- `score.transcribe` / `media.enqueueAudio` などは録音中 disabled
  (録音先の音源を不確定にしない・出力を録音に混入させないため)。
- しかし以下はレジストリを通らず、そのまま動いてしまう:
  - 区間ラベルの ↻(この区間を再採譜)→ retranscribeWithOptions
  - 波形選択の「この区間を再採譜」(prop でゲート済みだが、
    統一的ではない)
  - 採譜オプション dialog の「この設定で採譜し直す」(コマンド経由
    で開くので現状安全だが、経路としては同じ)
  - AUDIO_READY の「キューに追加」→ enqueueCurrentAudio(直接呼び出し)

## 提案

- `retranscribeWithOptions` と `enqueueCurrentAudio` の先頭で
  `captureState.phase === "recording"` を検査し、録音中は
  ステータスバーにアナウンスして早期 return する(他の disabled
  コマンドと同じ honest-feedback ルール)。

## 受け入れ条件

- 録音中にラベル↻・波形アクション・キュー追加のどれからも採譜系
  ジョブが発火しない。
- 録音停止後は通常どおり使える。
