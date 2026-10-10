## 概要

#42 — 録音を始める前に入力レベルを確認できる、プリレコード・レベルモニターを追加する。

これまでレベルメーターは録音開始後にしか見えず、「録り始めてから無音/クリップに気づく」失敗が起き得た。取り込みメニューからデバイスを選んだ時点でライブの入力レベルが見えるようにし、録り直しを防ぐ。

## 仕様

- 取り込みメニュー内の各ソース(システム音声/マイク)セクションに「入力レベル」行を追加。クリックでモニターをトグルし、動作中は行の右端にミニ・レベルメーターを表示(70% 以上で警告色、95% 以上でクリップ色)。
- メニューを閉じるとモニターは自動停止。デバイス選択(persistOnClick でメニューを開いたまま)のたびに選択デバイスでモニターが張り替わる。
- モニターセッションは録音セッションと同じ枠を使うが、temp WAV を一切書かない(monitor_only)。stop() は契約エラー、終了は cancel() のみ。
- 録音開始時にモニターが残っていれば先に畳んでから本録音に入る。モニター中の致命的エラー(デバイス切断等)はポーリングで拾ってアナウンスする — 録り始める前にデバイス不良を検知できる。
- ブラウザポートも同一契約(monitorStream + AnalyserNode のみ、MediaRecorder は作らない)。

## 変更

- capture.rs: capture_start に monitor_only 追加。CaptureStatus.monitoring、モニターセッションは recordings ディレクトリ/temp WAV/ファイナライズを全てスキップ、capture_stop はモニターを契約エラーとして畳む。
- capture/ports.ts・types.ts: monitorOnly / monitoring をポート契約に追加。
- capture/runtimePorts.ts: Tauri ポートは引数を橋渡し、ブラウザポートは monitorStream 経路(AnalyserNode のみ)を実装。setupAnalyser を抽出して録音/モニターで共有。
- capture/controller.ts: MonitorState・startMonitor/stopMonitor/toggleMonitor・160ms ポーリングタイマー。selectDevice が idle 時にモニターを自動(再)開始、start() はモニターを先に畳む。
- components/primitives/Menu.tsx: persistOnClick・suffix(secondaryContent スロット)を HsMenuItem に追加。
- components/CommandBar.tsx: デバイス行を persistOnClick 化、:monitor 行とインライン LevelMeter を追加、メニュー close で stopMonitor。
- strings/ja.ts / styles.css: 文言 3 件と .hs-levelmeter スタイル。

## テスト

- controller.test.ts にモニター用ネスト describe +7 テスト(開始/ポーリング/停止/トグル/デバイス選択での自動開始/録音開始時の畳み込み/失敗アナウンス/死んだセッションの自動クリア)。21/21 通過。
- vitest 全 787 件、tsc・eslint クリーン。
- 未検証: Rust 側はローカルにリンカが無くコンパイル未検証(差分レビュー + 括弧対応で確認)。実機での getUserMedia/WASAPI 動作は要手動確認。

Closes #42
