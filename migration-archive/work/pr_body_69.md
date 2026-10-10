## 概要

Issue #69「録音開始待ちの間 UI が実体のない『録音中』になる」を修正。
実際に vite dev + ブラウザで再現・修正後の挙動を動的検証しました。

## 変更

- `CapturePhase` に `"starting"` を追加 — `port.start()` の await 中は
  録音中ではなく開始中として扱う pre-session 位相。
- `start()`: 開始待ちの間に離脱されていたら(cancel/stop/dispose)
  解決直後に `port.cancel()` — 遅れて開いたセッションの孤児化を防止。
- `stop()` は starting 中 cancel 相当、`cancel()` は starting を受付、
  `pause()/resume()` は recording のみ(幽霊一時停止の排除)、
  `dispose()` は starting を idle に倒して遅延セッションを畳む。
- 共通述語 `captureSessionActive(state)` を新設 — recording||starting。
  コマンドゲート `snapshot.isRecording`、非レジストリ経路 6 箇所、
  `ImportStates` の録音ボタン disabled に適用。
- `snapshot.isRecordingStarting` を追加し `media.pauseCapture` の
  isEnabled から starting を除外(コマンドパレットでも有効誤表示しない)。
- CommandBar: starting 中は「開始しています…」表示 + 一時停止ボタン非表示
  (中止は押せる) — `ja.capture.startingLabel` 追加。

## 実機検証 (vite dev + ブラウザ)

- getUserMedia が解決しない環境で「開始しています…」+ 一時停止非表示 +
  中止で idle 復帰を確認(修正前は 00:00.0 凍結・幽霊一時停止・
  「録音が開始されていません」エラーを実機で再現)。

## テスト

- controller.test.ts +6 (deferred-port: starting 表示/幽霊 pause なし/
  cancel 後の遅延セッション畳み込み/stop=cancel/二重 start 拒否/dispose)
- vitest 関連4ファイル 80件 pass / tsc / eslint clean

Closes #69

