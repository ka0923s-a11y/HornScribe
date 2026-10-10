## 症状

`apps/desktop/src/quality/copyDrift.test.ts` > "every implemented error id exists in the deck with matching copy" が main 上で失敗している:

```
AssertionError: expected [ 'noPitchedContent' ] to deeply equal []
```

## 原因

#153 / #154 で `ja.errors.noPitchedContent` を追加した際、正本のコピーデッキ `protocol/copy/ja-JP.json` への反映が漏れた。#116 のドリフトガードは CI（GitHub Actions 不使用）が無いため検出されず、main で赤いまま残っている。

## 対応

デッキ `errors` に `noPitchedContent` を ja.ts と同一文面で追加する。
