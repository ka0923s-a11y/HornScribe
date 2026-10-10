## 概要

#247: ページ表示モードで全ページの SVG を毎回生成していたのを、
表示ページのみの lazy render + 隣接ページの idle prefetch に変更。

## 変更

- `verovio.ts`: `renderPage(page)` を追加（renderStats 計測込み）
- `ScoreReadyWorkspace.tsx`:
  - `pageCount` state を新設し、`pages`（描画済みSVG）と分離
  - page mode の `renderScore` は `getPageCount`（load 時点で正しい値を返すことを実測確認）+ 現在ページ1枚のみ render
  - `pageCacheRef`（render 毎に作り直す Map）でページ SVG をキャッシュ — XML/pitch/zoom/mode 変更で自動無効化
  - `ensurePage` でページ移動時に lazy render（prefetch 済みならキャッシュヒット）
  - `schedulePagePrefetch` で前後1ページを `requestIdleCallback` prefetch
  - 範囲外ページは Verovio が空 stub SVG を返すため `pageCountRef` でガード
  - ページャー・repagination クランプを `pages.length` → `pageCount` に修正

## 計測（800小節 / 8ページ譜面, Node + verovio/wasm）

| 操作 | 変更前 | 変更後 |
|---|---|---|
| page mode 初回表示 | 全8ページ render ≈170ms | 1ページ ≈25ms |
| zoom / F管切替 | 全ページ再 render | 現在ページのみ |

ページ数に比例していた render cost が「現在ページ操作」では概ね一定になる。

## 受け入れ条件との対応

- page mode 初期表示で全 page の renderToSVG を呼ばない ✓（1枚のみ）
- zoom/F管切替で必要ページ以外を同期 render しない ✓
- review/follow の page jump は `setCurrentPage` → `ensurePage` で lazy render ✓
- selection/active/loop marks は `pages` 更新後の既存 layout effect が lazy ページへ再適用 ✓
- continuous mode は従来通り全ページ（別段階で virtualization 検討）

## 検証

- `tsc --noEmit` / `eslint` クリーン
- `vitest` 52ファイル 516 テスト全緑
