Closes #218
Closes #220
Closes #227
Closes #228

## 変更 (4コミット)

- **#220** CommandBar overflow の note-split / note-merge /
  rest-to-note / requantize が onSelect 未接続で無反応だったものを
  commands.invoke へ接続。
- **#227** 採譜オプション初期化 effect の依存から settings を外し
  (ref 経由で最新値を読む)、テーマ等の無関係な設定変更で
  texture/simplicity/range が既定値に戻る問題を解消。
- **#228** meter=auto 時は手動 BPM でも beat track → estimate_meter
  を実行。従来は tempo_bpm 指定で推定自体がスキップされ 4/4 仮置き
  になっていた。
- **#218** HornScribeProject に extras フィールドを追加し、
  scoreDocument / musicXmlConcert / musicXmlHornF / reviewIssues /
  meta を保存ラウンドトリップで保持 (schema キーは常に優先)。
  これにより #219 の SOURCE_MISSING でのスコア復元経路も実質的に
  機能する。

## テスト

- test_worker.py に extras 保持の回帰テスト追加。
- pytest (worker/project/transcription/meter) ・ vitest ・ eslint ・
  tsc パス。
