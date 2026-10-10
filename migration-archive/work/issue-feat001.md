## Goal
音声ファイルを開くだけでなく、PC上の再生音源(システム音声)とマイク録音から直接採譜ワークフローに入れるようにし、生成した楽譜を自動演奏(スコア同期再生)できるようにする。

## Dependencies
なし(新規機能)。UI-020 インポートフロー、UI-004 トランスポート契約、UI-030 スコアワークスペース、ADR-0002 プロセス境界に依存。

## Non-goals
- AMT推論パイプライン自体の実装(Basic Pitch 連携は別マイルストーン)
- 多トラック同時採譜、ソース分離
- 録音のファイル永続化/編集機能(DAW化しない)
- 再生用音源の高品位シンセサイザー(MIDI/サウンドフォント差し替えは後続検討)

## Contracts touched
- `src-tauri`: WASAPI ループバック/マイクキャプチャを行う app-defined commands(ACL非対象のため自己制限実装)、`windows` crate 依存追加
- `src/import`: 録音由来の in-memory ソース種別を追加、`ImportController` に録音取り込み経路
- `src/score`: `ScorePlaybackSynth`(playbackTable + WebAudio でスコアを発音する再生チャンネル)
- `protocol/copy/ja-JP.json` + `strings/ja.ts`: 日本語UIコピー追加
- `commands/definitions.ts` + `commands/types.ts`: 新コマンド(録音開始/停止、スコア演奏トグル)

## Acceptance criteria
- EMPTY / AUDIO_READY 状態から「PCの音を取り込む」「マイクで録音」を開始でき、停止後にその音声が AUDIO_READY として読み込まれ採譜を開始できる
- 録音中は録音状態が明示され、キャンセルできる
- SCORE_READY で「楽譜を演奏」をオンにすると、スコアクロックの進行に合わせて各ノートが発音され、追従カーソルと同期する
- 元音源再生とスコア演奏は独立したチャンネルとして共存できる(比較試聴が可能)
- 失敗時(デバイスなし/権限拒否/非対応環境)は日本語の回復可能エラーになる
- ブラウザ dev 環境ではマイク録音のみ動作(getUserMedia)。システム音源は Tauri 必須であることを明示

## Tests
- Rust: WASAPI キャプチャの単体テストはCI上でデバイス非依存の形(バッファ→WAVエンコード)に限定
- TS: 録音取り込みコントローラ・スコア演奏スケジューラを vitest で
- 既存 pytest / tsc / eslint が通ること

## Evidence
- `docs/` に機能ノートを追加、録音→AUDIO_READY→採譜、およびスコア演奏の手順を記録
