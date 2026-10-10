## 概要

`npm run ui070:dogfood` が Task A (audioReady → 採譜 → scoreReady) で 120 s タイムアウトする。`#/dev/state/audioReady` 上で「採譜を開始」を押しても job が一切走らない。

## 原因

#219/#222/#234 (56f394d2) で command snapshot の `hasAudio` が `commandStateFor(screen).hasAudio && importState.audio != null` に強化された。これは本番では正しい (audioReady は必ず実音源を持つ) が、強制 dev state は画面だけを切り替えて `importState.audio` をセットしないため:

- `#/dev/state/audioReady`: 採譜を開始ボタンは描画される (optionsInvalid でしか disabled にならない) が、クリックは `commands.invoke("score.transcribe")` の isEnabled:false で止まり「操作できません」announce のみ。
- `#/dev/transcribing`: mount 時の自動 `score.transcribe` も同じゲートで無効化 → この dev ルートも死んでいる。

UI-070 時点 (7a67426d) では hasAudio が画面のみで決まったため dogfood は全完走していた (docs/UI_070_VALIDATION_RESULTS.md の記録値: Task A ~3.6 s)。**dev プレビューの仕様不整合** — 見た目は audioReady だが音源スロットが空で、主要コマンドが全て死んだ画面になっていた。

## 対応方針

- DEV 限定で `ImportController.devSeedAudio()` を追加し、強制 state が `commandStateFor(forced).hasAudio` を満たすのに audio が空のとき、決定的な fixture 音源 (生成した 16-bit PCM WAV blob) を slot に積む。transport.load / staging / mock job の経路は実音源と同一。
- `#/dev/transcribing` の auto-start は seed → audio 反映後に invoke する2段に修正。
- 本番バンドルには影響しない (import.meta.env.DEV ゲート)。

## 検証

- 修正後に `node scripts/ui070/dogfood.mjs` 全8タスク+§7 フローを実走行で確認。