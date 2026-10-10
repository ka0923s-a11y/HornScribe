実機検証(ブラウザ dev + dev engine bridge)で発見。

kind:"file" のドロップ(ブラウザ dev / File ref)は staging.ts が %TEMP%/hornscribe-dev/staged-<ts>-<name> に書き出して job.start に渡す。結果、scoreDocument.sourceAudioPath / スコアタイトルが `staged-1790284231128-runtime-fixture` のような一時ファイル名になる(実機スクリーンショットで確認)。ユーザーが見るタイトルは元のファイル名(runtime-fixture.wav)であるべき。

## 対応
- スコアタイトル/表示名は元の fileName を使い、staged 一時パスは内部参照に留める
- sourceAudioPath は staged パスのままでもよいが、表示用 displayName を別途保持するか、タイトル導出時に staged- プレフィックス+タイムスタンプを剥がす
