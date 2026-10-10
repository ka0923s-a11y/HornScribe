## 概要

`main.tsx` の `PrototypeApp` 遅延ルート(`#/prototype/*`)は DEV ゲートがなく、本番ビルドにもプロトタイプの JS チャンクが同梱される。実害は「配布物に spike 資産が乗る」(サイズ・表面積)で、仕様上も「prototype は実験資産」の境界に反する。

比較: `App.tsx` の `DevGallery`(#/gallery)は `import.meta.env.DEV` でゲート済み — prototype 側だけゲート漏れ。

## 対応
`main.tsx` で `import.meta.env.DEV` ゲートを追加し、本番ビルドからチャンクを落とす(DevGallery と同じパターン)。Vite の dead-code elimination で `import()` 自体が除去される。

## 検証
- dev で `#/prototype/*` が引き続き動くこと
- `vite build` の出力に prototype チャンクが含まれないこと
