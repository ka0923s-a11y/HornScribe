## 背景

#201 でテンポ記号の音符グリフが ☒ 化する問題を CSP（`font-src data:`）で修正したが、WebView2 が inline SVG 内の `<style>@font-face` を解決しない環境・バージョンでは依然として再現し得る。SMuFL テキスト（テンポ拍子音符、ダイナミクス等のテキスト出力グリフ）は Leipzig Web フォント依存で、これが落ちると譜面の特定グリフだけが豆腐になる。

## 改善方針

verovio wasm に同梱される Leipzig フォント（WOFF2, ~44KB, SIL OFL）をアプリのアセットとして同梱し、ドキュメントレベルの `@font-face`（`font-src ''self''` で許可済み）で宣言する。SVG 内部埋め込みが失敗しても `font-family="Leipzig"` のテキストは必ず正しいフォントで描画される二重化構成。

## 受け入れ

- `document.fonts.check("720px Leipzig")` がリリースビルドで true
- インライン SVG のフォント読み込みが失敗する環境でもテンポ記号が音符グリフで描画される
