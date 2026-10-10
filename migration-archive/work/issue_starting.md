## 概要

録音開始時、`port.start()`(getUserMedia / WASAPI セッション確立)が
解決する前から UI が「録音中」位相に入る。デバイス応答が遅い・
権限プロンプトが解決しない間、**実体のない録音中**が表示される。

## 再現(実機確認済み / vite dev + ブラウザ)

1. 「取り込み」→「マイクで録音」を押す。
2. `getUserMedia` が解決しない環境では UI が録音中になるが、
   - 経過タイマーが `00:00.0` のまま永久に凍る(`startTimer()` は
     start 解決後にしか呼ばれない)
   - 「一時停止」ボタンが押せて「一時停止中」表示になる
     (port.pause は no-op なのに状態だけ paused になる幽霊操作)
   - 「終了して取り込む」を押すと `CAPTURE_NOT_ACTIVE` →
     「録音が開始されていません。」とエラーになる(録音中表示と矛盾)
3. さらに深刻なのは「やめる」後に `port.start()` が遅れて解決した
   場合 — `setState({phase:recording})` + `startTimer` が走り、
   **ユーザーの知らないうちに本物の録音セッションだけが走り続ける**
   (孤児化。マイクインジケータが点きっぱなしになり得る)。

## 原因

`CaptureController.start()` が `await this.port.start()` の**前**に
`setState({phase:"recording"})` するため、port.start が pending の
間、位相ガード(一時停止/停止/中止)が全て「録音中」として通る。

## 方針

- `CapturePhase` に `"starting"` を追加し、開始待ちを独立位相にする。
- start 解決時に位相を再確認 — 開始中に離脱済みなら即 `port.cancel()`
  で遅れて開いたセッションを畳む(孤児化防止)。
- starting 中: 一時停止/再開は無効(ボタン自体を出さない)、停止ボタンは
  「開始しています…」表示で中止相当、中止も受け付ける。
- コマンドゲート `isRecording` に starting を含める(セッションが
  いつ生まれてもおかしくない間はファイル操作等を塞ぐ)。

録音開始・一時停止・停止・中止・孤児化の各シナリオは
`controller.test.ts` の deferred-port テストで固定する。

