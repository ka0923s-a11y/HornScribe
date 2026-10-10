## 概要

テンポ「手動」で BPM 未入力のまま採譜を開始できてしまう不整合を
修正する (#61)。params が tempoBpm を emit せずエンジンは自動判定に
黙って戻り、ユーザーの明示した「手動」が無視されていた。

## 変更内容

- `transcriptionParams`: `invalidManualTempo`(manual && tempoBpm==null)
  と、全フィールドエラーを束ねる `invalidTranscriptionOptions` を追加
  (#346 selection range + #61 manual tempo)。
- `TranscriptionOptionsFields`: 手動 BPM フィールドにエラー
  「手動テンポにはBPMを入力してください」を表示。
- `ImportStates` / `TranscriptionOptionsDialog`: 採譜を開始・
  キューに追加・dialog 適用のゲートを invalidSelectionRange から
  invalidTranscriptionOptions へ一本化。

## 動作確認

- vitest +2(#61 describe): manual+null=true / manual+120=false /
  auto=false、結合ゲートが range・tempo どちらでも true になること。
- 既存の #346/#55 テストも通過。

Closes #61
