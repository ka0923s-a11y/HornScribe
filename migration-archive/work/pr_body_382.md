## 概要

GUI_UX_SPEC §1「内部実装をユーザーへ露出しない」に反し、通常の音符プロパティに
`sn-000123` のような canonical note ID を常時表示していました。
演奏者が音符を判断・修正する情報ではなく、視覚ノイズでした。

## 変更点

- `PropertiesPanel` の `NoteBody` から canonicalId行を削除。
- `ja.inspector.fields.canonicalId` を削除。
- `model.canonicalId` 自体は inspector model / diagnostics 用に保持（情報自体は捨てない）。

## 検証

- `tsc` / `eslint` / `vitest`（PropertiesPanel + inspector）：クリーン。

Closes #382
