## 概要
Issue #338 — dirty 判定が `editVersion`(単調増加counter) 基準のため、Undo で保存済み状態へ完全に戻っても `*` と未保存ガードが残ったままになる問題を修正。

## 変更内容

### `score/dirtyFingerprint.ts`（新規）
- 保存される内容と同じ意味単位の fingerprint: canonical `revisionId`（内容由来ハッシュ）、overlay note edits（pitchDelta/deleted/enharmonic・id ソートで順序非依存）、review decisions、notation `meta` 全体、source identity（originalPath）、projectId
- `revisionId` がすでに content-derived なので XML bodies / canonicalDoc の逐次 serialize は不要 — 500ms poll に乗る軽量実装
- `dirtySourceIdentity()`: loaded ref 優先・なければ projectSourceRef（保存側 sourceAudio の解決と同じ順序）

### App.tsx
- `savedEditVersionRef` → `savedFingerprintRef`（保存成功時・project open 時に fingerprint を採取）
- dirty poll が fingerprint 比較へ — Undo で完全に戻れば dirty=false、`Edit → Undo → Redo` は dirty=true
- dirty→clean 遷移時に `project_autosave_clear`（保存成功と同じ回収）— 不要な recovery snapshot が残らない
- `onProjectRelinked`: 明確な baseline null 化をやめ、relink による source path 差異を fingerprint の差として自然に検出（元パスへ戻せば clean に戻る=正直な動作）
- open 時 baseline は `audio:null` + recorded priorSource で採取 — 前 project の audio が残っている瞬間に誤 baseline を取らない

## テスト
- `dirtyFingerprint.test.ts`（新規 7件）: 同一→equal / pitch・delete・enharmonic 各 facet → dirty / 挿入順序非依存 / decision のみ変更・open へ戻せば clean / meta・revision → dirty / relink 別パス → dirty・元パス → clean
- `npx tsc --noEmit` / eslint / vitest ✅

## 受け入れ条件との対応
- save→edit→undo で dirty=false・`*` 消滅・close で未保存 dialog なし ✅ / redo で dirty ✅ / decision・enharmonic・metadata も identity 内 ✅ / saved へ戻れば autosave recovery も clear ✅

Closes #338
