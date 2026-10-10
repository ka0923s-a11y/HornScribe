## 概要

採譜オプションでテンポ「手動」を選んでも BPM を入力しないまま採譜を
開始できる。その場合 buildTranscriptionParams は tempoBpm を emit
せず、エンジンは自動判定に戻る — ユーザーの明示した「手動」という
意図が黙って無視される。#346(空・逆順の選択範囲をエラーにする)と同じ
種類の仕様不整合。

## 提案

- `transcriptionParams` に `invalidManualTempo(options)` を追加し、
  tempo=="manual" かつ tempoBpm が未入力を不正とする。
- `TranscriptionOptionsFields` でテンポ(手動)フィールドにエラーを出し、
  採譜を開始 / キューに追加 / dialog の適用ボタンを無効化する
  (#346 と同じ pattern)。

## 受け入れ条件

- 手動テンポ未入力では採譜を開始できず、フィールドに理由が出る。
- BPM を入力すると解除される。
