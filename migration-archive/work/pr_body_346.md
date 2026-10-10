## 概要
Issue #346 — 「採譜する範囲 = 選択範囲」で開始 ≥ 終了を入力しても、frontend が黙って全曲範囲へフォールバックし、意味の違う job を実行していた問題を修正。

## 変更内容

### フォームバリデーション（受け入れ条件どおり）
- `invalidSelectionRange()` を新設: range==="selection" かつ clamp 後 `end <= start` で invalid
- `AudioReadyBody`: invalid 中は **採譜を開始を disabled**
- 終了フィールドに Fluent validation error（`終了は開始より後の時刻を指定してください`）を表示
- 波形ドラッグや数値修正で有効になれば即時解除（live 再計算）

### 契約の正直化
- `buildTranscriptionParams` の silent full-range フォールバックを削除 — clamp は維持するが反転/空区間はそのまま送り、漏れた場合は engine 側の明示的 selection エラーが正直な結果になる
- 未設定フィールドは従来どおり 0/duration 既定（有効な全範囲選択）

## テスト
- `transcriptionParams.test.ts`: 反転・同値・範囲外 clamp・全曲 mode・未設定既定の 6 ケース
- `ImportStates.test.tsx`: audioReady で反転→submit disabled + popover 内 field error 表示、同値→disabled、有効→enabled、全曲 mode は stored seconds を無視
- `npx tsc --noEmit` / eslint / vitest 32件 ✅

Closes #346
