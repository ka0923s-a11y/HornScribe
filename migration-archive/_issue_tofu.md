## 症状
採譜結果の楽譜で、テンポ記号が「☒ = 151.39」のように音符部分が豆腐（□に×）化する。数値テキストは正常で、音符グリフだけが欠ける。

## 原因
Verovio は `<metronome>` の beat-unit を SMuFL グリフ（Leipzig フォント、SVG 内 `@font-face` に woff2 を data URI で埋め込み）の**テキスト**として出力する。音符・譜表などは `<use>` 参照の path なのでフォント不要だが、テンポ記号の音符だけはこの Web フォントに依存する。

`apps/desktop/src-tauri/tauri.conf.json` の CSP が `font-src ''self''` のため、data URI のフォントがブロックされ、PUA コードポイントがフォールバックフォントの .notdef（☒）で描画される。

## 修正
CSP に `font-src ''self'' data:` を追加する。`img-src` は既に `data:` を許可済みで同種の緩和。

## 再現
v0.2.10 で任意の音源を採譜 → 楽譜のテンポマークが ☒ になる。
