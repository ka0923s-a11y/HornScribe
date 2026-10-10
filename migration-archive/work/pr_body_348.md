## 概要

単一ドキュメントアプリとして「音源は1ファイルずつ」は正しい製品境界ですが、
複数ファイルD&Dで先頭1件だけを黙って採用し、残りを無視していました。

## 変更点

- `importRefs` で `refs.length > 1` のとき `announce(multiFileNotice)` を発行
  （先頭ファイルを開く動作は維持、制約を明示）。
- `ja.import.feedback.multiFileNotice` を追加。

## 検証

- `controller.test.ts`：multi-file dropで `multiFileNotice` がannounceされることをassert。
- `tsc` / `vitest`：クリーン。

Closes #348
