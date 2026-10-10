## 概要

採譜ジョブ実行中に「エンジンを再起動」を押せてしまい、走っているジョブが黙って kill される。

## 経路

- 診断情報シートの「エンジンを再起動」ボタン
- 設定 → ツール → demucs 行の「エンジンを再起動」ボタン（#190 で追加）

どちらも `session.restartEngine()` を無条件で呼ぶ。`restartEngine` は旧クライアントを shutdown → kill するため、**実行中の採譜ジョブは中断され**、UI 側は `workerCrashed`/`transcriptionFailed` 相当のエラーになる。ユーザーが設定画面から（ジョブの存在を意識せず）再起動を押すケースが自然に起こり得る。

## 期待する動作

- エンジンが正常（ready/starting）かつジョブが未終了のとき、再起動を**拒否**する（防御）
- エンジンが crashed/unresponsive/offline のときはジョブ有無に関わらず再起動可（クラッシュ復旧経路を塞がない）
- UI はボタンを無効化し、理由（採譜実行中）を示す

## 修正方針

- `DiagnosticsSessionView.jobRunning` を追加し `session.getSnapshot()` から `job && !isSettled(job)` を流す
- `DiagnosticsInfo.jobRunning` で診断情報・設定画面の両方から参照可能にする
- `TranscriptionSession.restartEngine()` に defensive guard（engine が正常系 && job 未終了 → SidecarError で拒否）
- 両画面の再起動ボタンを jobRunning で disabled + 注記表示
