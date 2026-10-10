## 概要

スコア画面から採譜オプションを開いて再採譜できるようにする (#55)。

AUDIO_READY の採譜オプション popover は採譜が始まると二度と開けない。
採譜後に「調を変えて再採譜」「テクスチャを変えて再採譜」といった調整の
入口が無く、Review の quick-retranscribe(3 つの固定プリセット)が唯一の
手段だった。フィールド群を共有コンポーネントに切り出し、スコア画面
から開ける dialog を追加した。

## 変更内容

- **`import/TranscriptionOptionsFields.tsx`** (新規): AUDIO_READY の
  popover が持っていた選択肢定数とフィールド並びをそのまま移管。
  `options` / `durationSec` / `onChange` を受け取るだけの純粋な
  表示コンポーネント。manual tempo・voices cap・範囲入力などの
  条件付き表示と #346 の rangeInvalid 判定もここに集約。
- **`import/TranscriptionOptionsDialog.tsx`** (新規): スコア画面用の
  dialog。draft state は RequantizeDialog と同じ render-time seed
  で open のたびに live options を取り込み、キャンセルなら stored
  options を一切変更しない。適用は「この設定で採譜し直す」。
- **`ImportStates.tsx`**: popover 内のフィールド群を共有コンポーネント
  へ差し替え(約 230 行削減)。`audio` を `durationSec` に渡す形に変更。
- **command `score.transcribeOptions`** (「採譜オプション…」):
  `isVisible: hasScore` / `isEnabled: hasAudio && !isTranscribing &&
  !isRecording`。command bar の overflow メニューにも項目を追加
  (palette だけだと見つけにくいため)。
- **App.tsx**: `openTranscribeOptions` ctx → dialog 開閉 state。
  適用は `retranscribeWithOptions(draft, commit)`(#343 の guarded
  transaction)を通すので、未保存確認をキャンセルしても stored
  options は変わらない。

## 動作確認

- vitest 821 (+4): 新規 `TranscriptionOptionsDialog.test.tsx` が
  seed/draft-編集の適用/invalid-range gate/reopen re-seed を検証。
  既存の #346 popover テストも DOM を保っているためそのまま通過。
- tsc / eslint / copy テスト クリーン。
- コマンドは command palette・overflow メニュー両方から辿れる。

Closes #55
