## 概要

dirty score から再採譜を開始すると `startTranscriptionJob()` が自分自身を `pendingNav` に積み、
「保存せずに続ける」で pending action を実行しても `dirtyRef.current` が true のまま
同じ guard に再入して確認ループになっていました。
「保存して続ける」も `dirtyRef` の 500ms poll 更新前に action を実行するため同様に race していました。

## 変更点

- `startTranscriptionJob(overrides, skipGuard)` に第2引数を追加。
- dirty guard が pendingNav へ積む closure を `startTranscriptionJob(overrides, true)` に変更 —
  確認済みの再入は guard を skip し、「保存せずに続ける」「保存して続ける」の両方が完了する。

## 検証

- `tsc` / `eslint`：クリーン。

Closes #347
