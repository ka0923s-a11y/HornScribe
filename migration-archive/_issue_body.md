## 背景(GUIデザイン/仕様の不整合)

DESIGN_SYSTEM §13 option A「ダーククローム + 明るい楽譜ペーパー」の設計上、`--hs-surface-score` は両テーマで明色(#ffffff/#fafafa)で、コントラストゲート(contrast.ts)には「text tokens never land on --hs-surface-score — the paper carries score-ink/staff tokens only」と明記されている。

しかし実際にはクローム用テキストトークンが紙面に直接乗っており、**ダークテーマでスコア領域のUIテキストがほぼ不可視**になる(実測スクリーンショット: 空状態のタイトル「ここに音声ファイルをドロップ」が白地に白で読めない):

- `.hs-score` の `color: --hs-text-primary`(dark = #ffffff)が紙面 #fafafa 上に → 継承で `.hs-empty__title` `.hs-transcribing__title` 等が不可視
- `.hs-empty` の capture-title/or/formats/privacy/hint、`hs-transcribing__meta/note` が text-secondary(#d6d6d6)/muted(#adadad) → 紙面上で読みづらい
- `.hs-score__empty-title` `.hs-score-paper` `.hs-score-loading` `.hs-score-error h2/p` も同様
- `.hs-empty__capture-error` の --hs-status-error(dark = #f1707b)は紙面上で約2:1
- `.hs-score--dragover` の outline --hs-accent(dark = #479ef5)は紙面上で約2.4:1

## 修正案

- 紙面専用のインクランプを追加: `--hs-score-ink-secondary: #424242` / `--hs-score-ink-muted: #616161` / `--hs-score-ink-error: #c50f1f`(紙面は両テーマで明色なのでライトテーマ値をそのまま採用、`:root` 共有ブロックに配置)
- `.hs-score` の color を `--hs-score-ink` に変更 + 紙面上の透明要素(empty/transcribing)にスコープ付きトークン再バインド、リーフ要素(score-paper/loading/error/dragover)は個別差替え
- contrast.ts のペアカタログに新トークン on --hs-surface-score を追加してWCAGゲートへ乗せる

## 影響範囲

`.hs-score` 内の自前サーフェスを持つ子(score-toolbar = panel、reviewbar = review-tint、follownote = elevated、error-surface = elevated)は既に正しく、この修正の対象外。Verovio 記譜は score-ink 系で既に正しい。
