## 概要

`ScoreReadyWorkspace` のスコア状態ミラー effect が親から届く `onStateChange` コールバックを依存配列に含んでおり、App 側の inline ラッパが毎レンダー新規生成されるため、**無限の再レンダーループ**が発生していた。

### 再現

dev サーバーで `#/dev/state/scoreReady`（および任意のスコア表示画面）を開くと、コンソールに React の "Maximum update depth exceeded" 警告が連続して記録される。実機のスコア画面でも同じパスを通るため、常時 render cycle を消費していた（見た目は正常に動作するため気付きにくい）。

### 原因

- `App.tsx`: `onScoreStateChange={(s) => { ...; setScoreState(s); }}` が毎レンダー新しい関数を生成
- `ScoreWorkspace.tsx`: `onStateChange={(s) => onScoreStateChange?.(s)}` も inline
- `ScoreReadyWorkspace.tsx`: ミラー effect の deps に `onStateChange` → effect が `setScoreState` を呼ぶ → App 再レンダー → 新しいコールバック → effect 再発火、の無限ループ

### 修正

`onStateChange` を `onStateChangeRef` で保持し（render 中に最新値を同期する既存パターン）、effect 内は `onStateChangeRef.current?.(...)` を呼ぶ。deps から `onStateChange` を除外。`controllerRef` は ref 書き込みのみで setState を呼ばないため対象外。

動的レビュー（#123 実装の実機検証中に dev コンソールで発見）。