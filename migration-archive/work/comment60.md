実装完了: PR #61 にて。

## 実装内容

- PC再生音源: WASAPI ループバック(`src-tauri/src/capture.rs`、app-defined commands、30分上限、WAV raw IPC)
- マイク録音: 同上(WASAPI eCapture)。ブラウザ dev では getUserMedia+MediaRecorder にフォールバック
- 楽譜自動演奏: `ScorePlaybackSynth`(WebAudio、ScoreCursorClock 追従、ループ/レート/シーク対応、実音)
- UI: EMPTY 状態に取り込みボタン2つ、コマンドバーに取り込みメニュー+録音中停止/中止、トランスポートに「楽譜を演奏」トグル(P キー)

## 検証

- tsc/eslint/vitest(315件)ローカルでパス
- Rust はローカルに MSVC リンカが無いため CI の desktop ジョブ(新設、#77)で cargo check/test を検証中

## レビューで派生した issue

- #70 録音データのプロジェクト永続化(リリンク対応)
- #71 録音中のライブレベル表示
- #72 楽譜演奏と元音源の同時再生制御
- #73 録音デバイス選択
- #74 30分上限の可視化(本 PR で対応済み: 上限到達アナウンス+ヒント明記)
- #75 ショートカット(本 PR で対応済み: 楽譜演奏=P)
- #76 録音完了時の既存音源の無確認置き換え
- #77 desktop CI 未整備(本 PR で対応済み: desktop ジョブ追加)

設計判断と既知の境界は docs/FEAT-001-capture-and-audition.md に記録。