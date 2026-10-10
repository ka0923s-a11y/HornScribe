## 概要

#12 — 区間ラベル/部分アノテーションを追加する。

#353 で波形の範囲選択が採譜後も動くようになった次の段階として、区間に名前(Aメロ/サビ/ソロ等)を付けてプロジェクトに残せるようにする。JPOP の構造単位でのレビュー・再採譜に効く。

## 仕様

- **区間ラベル** = 音源時間軸の startSec–endSec + 名前(最大24字)。波形直下にチップバーを表示し、音源が載っている間は常時見える。
- **追加**: 波形で範囲を選ぶ → 「ラベル」ボタン → 名前入力。チップをクリックするとその区間が波形バンドに戻り、既存のループ/再生操作がそのまま効く。
- **再採譜**: チップの ↻ でその区間だけを `range:"selection"` の再採譜(既存の retranscribeWithOptions 経路 — ガードもオプション反映も共用)。
- **永続化**: プロジェクト JSON のトップレベル extra `regionLabels` に保存。v1 バリデータは extras を無視し、Python 側 `HornScribeProject.extras`(model.py の _SCHEMA_KEYS 外)も未知キーをそのまま往復させるので、エンジン経由の open でも安全に生存する。
- **復元**: `ProjectSummary.regionLabels` を `projectSummaryFromDocument` でパース → `onProjectOpened`(スコア無し open)と `onProjectScoreReady`(scoreReady/sourceMissing open)の両経路で復元。壊れた行は parse 側で捨てる。
- **dirty 追跡**: ラベルの追加/削除/改名は未保存差分として dirtyFingerprint に含める(保存ベースライン・プロジェクト open ベースライン・500ms ポーリングの全呼び出しで同一セットを渡す)。
- **寿命**: 別の音源が載った時点でクリア(スコアと同じ identity 規則)。同一音源の再採譜では保持される(音源時間軸に付くため)。

## 変更

- `src/workspace/regionLabels.ts`: make/parse/serialize/fingerprint の純粋関数。
- `src/components/RegionLabelsBar.tsx`: 波形直下のチップバー(追加/選択復元/再採譜/削除)。
- `src/import/project.ts` + `types.ts` + `controller.ts`: `regionLabels` extra の書き込みと ProjectSummary への復元。
- `src/score/dirtyFingerprint.ts`: オプション `labels` 入力。
- `src/App.tsx`: 状態・操作・永続化・復元・クリア・バーのレンダー。
- `src/strings/ja.ts` / `styles.css`: 文言とスタイル。

## スコープ外(次の issue 候補)

- ラベル単位の書き出し範囲指定(エクスポート連携) — 現行の MusicXML/PDF エクスポートは全曲のみ対応で、区間書き出しにはエンジン側の分割が必要。

## テスト

- `regionLabels.test.ts` 新規7件(正規化/バリデーション/壊れた行の棄却/往復/fingerprint 不変条件) + `project.test.ts` に extras 永続化1件。
- vitest 全804件・tsc・eslint クリーン。

Closes #12
