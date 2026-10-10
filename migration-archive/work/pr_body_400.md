## 概要
Issue #400 — dirty score と録音中しかガードしていなかったため、長時間採譲中の window close が確認なしで通り、数分〜数十分の計算を一発の誤操作で失っていた問題を修正。

## 変更内容

### `workspace/closeGuard.ts`（新規）
- `closeGuardKind()` を純粋関数として切り出し: 優先順位 `dirty+transcribing > dirty > recording > transcribing > なし`
- dirty+transcribing は独立した `dirtyTranscribing` kind — 2つの確認を出さず1つの分かりやすい dialog で扱う

### App.tsx
- `transcribingActiveRef`（screen==="transcribing" mirror）を onCloseRequested と browser beforeunload guard へ追加
- `pendingClose` に `transcribing` / `dirtyTranscribing` kind を追加
- `confirmCloseAbortJob`: cooperative `cancelTranscription()`（worker へ正しく cancel が届く）→ `destroy()`
- dialog: transcribing →「採譲を中止して終了」(danger) +「戻る」、dirtyTranscribing →「保存して閉じる」(primary) +「採譲を中止して終了」+「戻る」
- copy: transcribing は「保存済みのプロジェクトと楽譜は保持されます」、dirtyTranscribing は「未保存の変更も失われます」と保持/損失を明示

## テスト
- `closeGuard.test.ts`（新規 7件）: idle clean → null、transcribing/dirty/recording 単独、dirty+transcribing の統合、優先順位
- `npx tsc --noEmit` / eslint / vitest ✅

## 受け入れ条件との対応
- active transcription close を確認なしで通さない ✅ / 戻るで job 継続 ✅ / 中止で cooperative cancel+shutdown ✅ / prior score 保持を copy で明示 ✅ / dirty+job を1つの dialog ✅ / recording 複合の優先順位定義 ✅ / idle close は追加確認なし ✅

Closes #400
