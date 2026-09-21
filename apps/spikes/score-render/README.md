# UI-003 — Verovio 楽譜描画スパイク

`docs/GUI_UX_PLAN.md` §49 Spike B の実装。MusicXML → SVG の描画、正準ID
(`sn-*`) ↔ MusicXML `note/@id` (`hs-sn-*`) ↔ 描画要素の対応、クリック選択、
時間↔要素マッピング、ズーム、コンサートピッチ↔F管ホルン切替を検証する。

詳細な結果と判定は `docs/UI_003_SPIKE_RESULTS.md` を参照。

## 実行方法

```bash
npm install
npm run dev        # 開発サーバー (Vite)
npm run build      # 本番ビルド → dist/
npm run preview    # dist/ をローカル配信して確認
npm run typecheck  # tsc --noEmit
npm run smoke      # Node + jsdom スモークテスト（実 Verovio WASM 使用）
```

オプション（ブラウザ E2E。依存には含めていない）:

```bash
npm i -D playwright && npx playwright install chromium
npm run preview &  # http://localhost:4173
node scripts/e2e-playwright.mjs   # SPIKE_URL でポート上書き可
```

## 構成

- `src/lib/ids.ts` — FND-001 ID 規則の TypeScript 版（`python/hornscribe/domain/ids.py` の鏡像）
- `src/lib/verovio.ts` — VerovioToolkit の薄いラッパ（初期化・描画・timemap・時間変換）
- `src/lib/domScore.ts` — 描画 SVG の要素インデックス・ヒット領域・ハイライト（DOM クラス切替のみ）
- `src/lib/scoreDoc.ts` — MusicXML → 音符モデル（並行アクセシブル表現用）
- `src/components/ScoreView.tsx` — ページ SVG 表示 + クリック委譲
- `src/components/NoteList.tsx` — `role=listbox` の並行表現（SVG非依存のa11y経路）
- `fixtures/multisystem_concert.musicxml` — `scripts/gen-multisystem.mjs` が生成する決定論的な24小節フィクスチャ（複数段・複数ページ・タイ・臨時記号・調号）
- `results/` — ブラウザ検証のスクリーンショット（`dpi_*.png` 等）

検証データのうちコミット済み ENG-001 フィクスチャ（`fixtures/musicxml/`）は
`?raw` インポートでバンドルし、完全オフライン動作を保証する。本番では
Python サイドカーから IPC で受け取る MusicXML 文字列と同じ形（文字列→
`loadData`）になる。
