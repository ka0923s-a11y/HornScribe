## 概要

録音中にコマンドレジストリを通らない採譜・取り込み経路が発火
できてしまう不整合を修正 (#63)。

## 問題

コマンドレベルでは録音中の音源スロット操作は一貫して無効
(file.openAudio, media.enqueueAudio, score.transcribe は全て
isEnabled:!isRecording)。だが以下はレジストリを経由しない:

- 区間ラベルの ↻ / 波形選択の「この区間を再採譜」
  → `retranscribeWithOptions`
- 採譜オプション dialog の適用 → 同上
- AUDIO_READY の「キューに追加」→ `enqueueCurrentAudio`
- キューパネルの「音源を追加」→ `enqueueAudioRefs`
- キュー行の「開く」→ `openQueueResult`(音源を載せ替える)

## 変更内容

それぞれの実装関数の先頭で `captureState.phase === "recording"` を
検査し、録音中は `ja.commandFeedback.disabled` をアナウンスして
早期 return。ガードの位置は呼び出し側ではなくジョブ発火の一点に
置いたので、今後増える経路も同じルールを自動的に拾う。

## 動作確認

- tsc / eslint クリーン、関連 vitest 207 件通過。

Closes #63
