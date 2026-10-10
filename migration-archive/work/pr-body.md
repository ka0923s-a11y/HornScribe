## 概要

#60 の3機能を実装:

1. **PC再生音源の取り込み**: WASAPI ループバックで既定再生デバイスの出力を録音
2. **マイク録音**: 既定キャプチャデバイスから録音
3. **生成楽譜の自動演奏**: Verovio timemap 由来の PlaybackTable とコンサートピッチの ParsedNote を WebAudio で発音

## 設計

- `src-tauri/src/capture.rs`: WASAPI 共有モードのポーリングキャプチャ(ループバックはイベント駆動不可のため)。`capture_start/stop/cancel/status` + `capture_take_wav`(raw IPC)。既存 `read_audio_bytes` と同じ自己制限パターン: 固定ソース・30分上限・WAVのみ・ACL外コマンドとしての制限内蔵。
- `src/capture/`: `CapturePort` シーム + `CaptureController`。ブラウザ dev ではマイクのみ `getUserMedia`+`MediaRecorder` にフォールバックし、ループバックは unsupported を返す。
- `src/score/playbackSynth.ts`: `ScoreCursorClock` 追従の発音エンジン。400ms 先読み + `scheduledUntilMs` ウォーターマークで重複スケジューリングを防止。ループ・レート変更・シーク(>400ms ジャンプ検出)に追従。実音(コンサートピッチ)で鳴らす。
- UI: CommandBar に取り込みメニュー + 録音中の停止/中止ボタン、EMPTY 状態に2つの取り込みボタン、TransportBar に楽譜演奏トグル(P キー)。コピーは ja.ts + ja-JP.json。

## 検証

- CI desktop ジョブ(本 PR で新設): tsc / eslint / vitest(315件) / cargo check / cargo test — windows-latest で全パス
- ローカル: tsc/eslint/vitest パス(Rust はローカルに MSVC リンカが無いため CI で検証)

## レビュー対応(本 PR 内で修正済み)

- #74: 30分上限の可視化 — `limit_reached` を返してアナウンス + EMPTY ヒントに明記
- #75: ショートカット — 楽譜演奏に `P` を割当(録音系は誤操作防止のため未割当を仕様化)
- #77: desktop CI — tsc/eslint/vitest/cargo check/test を windows-latest で実行

## フォローアップ issue(別途対応)

- #70 録音データのプロジェクト永続化 / #71 録音中ライブレベル / #72 楽譜と元音源の同時再生制御 / #73 録音デバイス選択 / #76 録音完了時の無確認置き換え

## 既知の制限

- 録音データはプロジェクト保存に含まれない(#70 で検討)
- ループバックは Windows/WASAPI 限定(デスクトップアプリのみ)
- 詳細は docs/FEAT-001-capture-and-audition.md

Closes #60
Closes #74
Closes #75
Closes #77