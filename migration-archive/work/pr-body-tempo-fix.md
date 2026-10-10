## 修正したバグ（ユーザー報告: tempo map editor がバグってる）

### 1. ÷2/×2 テンポオクターブ修正が複数セグメント譜面で消える

`TempoMapEditor` が `TempoField` を置き換える際 `onTempoScale` を渡していなかったため、rit./accel. を含む譜面では #198 のワンタップ半分/倍速修正が UI から消失していた。`scaleTempo` は tempo_map 全体をスケールするので、エディタ下部に同じボタンを復活（無効判定はマップ内 min/max BPM 基準）。

### 2. 追加行のボタンが初回クリックで反応しない

小節 SpinButton は入力値を blur でしか報告しない。小節を入力して「追加」をクリックすると、blur コミットと同じジェスチャでクリックが disabled ボタンに吸収され、無効時はフィードバックなしにボタンが死んだように見えた。ボタンを常時有効化し、クリック時に検証して小節フィールドにエラーを出す方式に変更（KeyMapEditor も同じ構造的バグを抱えていたため同時修正）。

### 3. BPM フィールドのレイアウト崩れ

`.hs-properties__tempo` が keymap 行内で flex を持たず、SpinButton が固有幅に潰れて行が壊れて見えた。`.hs-properties__meter` と同じ flex ルールを付与。

### 4. その他の整合性

- TempoField/TempoMapBpmField のラッパー onBlur/onKeyDown を除去（Fluent SpinButton の onChange がコミットを一意に担うため、ラッパー側は二重発火経路のデッドコード）
- 冒頭行の `startBeat` ハードコード `"0/1"` → `c.startBeat ?? "0/1"`（実セグメント位置を編集）
- 行 key を index から `startBeat` ベースへ（削除時のドラフト残留防止）

## 検証

- 新規 `PropertiesPanel.test.tsx`（6件）: 行描画・編集・削除・追加初回クリック・÷2/×2 復活・空小節エラーを jsdom で実検証
- 新規 `xmlDocument.test.ts`（3件）: `mergeTempoStarts` が canonical tempoMap の startBeat を各マークに付与・replaceContent で再マージ・canonical 欠落時は display-only 退化を検証
- `tsc --noEmit` / `eslint` クリーン、`vitest` 52ファイル 516 テスト全緑
