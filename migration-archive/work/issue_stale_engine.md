## 概要

同梱用フリーズエンジン `resources/engine/hornscribe-engine.exe` が、
worker に追加されたメソッド・caps を含まない古いビルドだった。
実機で `engine.handshake` を叩いたところ、`project.save` /
`project.open` / `score.edit` / `export.midi` と `demucsAvailable` /
`ffmpegAvailable` caps が全て欠けていた。

## 影響

- 開発環境では解決順が repo venv 優位なので表面化しないが、
  `tauri.bundled.json` で作るリリース物はこの exe を同梱するため、
  プロジェクト保存/開く・リズム編集・MIDI書き出し・診断 caps が
  `unknown method` で失敗する — リリースブロッカー。
- 既存の `smoke_engine.py` は handshake + basic_pitch 実採譜だけを
  検証するため、この種のメソッドドリフトを検出できない。

## 対応

- エンジンバイナリを `scripts/build_engine.py` で再ビルドする。
- `smoke_engine.py` に必須メソッド集合の assert を追加し、
  今後のドリフトをリリース前検証で確実に拾えるようにする。

## 受け入れ条件

- 再ビルドした exe の handshake に上記メソッド・caps が含まれる。
- smoke_engine が必須メソッド欠落を検出して失敗する。
