## 概要
Issue #343 — Review の再採譜 quick action (voices / vocalIsolation / Basic Pitch) が dirty score の未保存確認を出す**前に**採譜設定を書き換えており、キャンセルしても設定だけが変更済みになる問題を修正。

## 変更内容

### `import/retranscribe.ts`（新規）
- `requestRetranscription()` を純粋関数として切り出し: option-mirror + job-start を1つの guarded transaction にする契約を明文化
- `audioLoaded=false` → 通知のみ、`dirty` → commit+startJob(skipGuard) を丸ごと pending へ queue、clean → 即時実行

### App.tsx
- `retranscribeWithOptions` を追加し、3つの quick action を全て同じ transaction semantics へ統一
- `onRetranscribeBasicPitch`: `updateSettings({backend})` を**削除** — per-job pin は `settings.backend` に常に優先するため、一回限りの再採譜が global default を書き換える必要がない（issue の再検討提案を採用）。採譜オプションへの mirror は維持（popover の backend 表示は正直に反映）

## テスト
- `retranscribe.test.ts`（新規）: clean→即時 commit+start / dirty→queue のみ・cancel で commit 無し / dirty 続ける→commit→startJob(skipGuard) の順序 / no-audio→通知のみ
- `npx tsc --noEmit` / eslint / vitest ✅

## 受け入れ条件との対応
- dirty score で cancel → 設定不変 ✅ / voices・vocal・BasicPitch 同一 semantics ✅ / 続ける時のみ commit+start ✅ / global default を不必要に変更しない（Basic Pitch remedy から updateSettings 削除）✅

Closes #343
