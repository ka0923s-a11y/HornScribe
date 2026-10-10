## 概要

同梱エンジンのドリフト検出と同梱 tools のバンドル配線 (#65, #10)。

## 発見

`resources/engine/hornscribe-engine.exe` はローカル成果物(gitignore)だが、
実機の handshake で `project.save` / `project.open` / `score.edit` /
`export.midi` と `demucsAvailable` / `ffmpegAvailable` caps が欠落して
いた — このバイナリでリリースすると採譜以外の全 RPC が失敗する。
`smoke_engine.py` は handshake + 実採譜しか見ないため、このドリフトを
通過させてしまう。

## 変更内容

- **`scripts/smoke_engine.py`**: handshake の caps.methods に必須
  メソッド集合(engine.*/job.*/project.save/project.open/score.edit/
  export.midi)の欠落 assert を追加。debug.* は spike 専用で必須外。
- **`apps/desktop/src-tauri/tauri.bundled.json`**: bundled tools の
  マッピング `"resources/tools/*" → "tools/"` を事前配線 — 同梱
  ffmpeg を置くだけでビルドが拾う(#10)。
- **`resources/tools/README.txt`**: engine/ と同じ placeholder パターンで
  置き方を同梱物自身に記録。
- **`docs/PACKAGING.md`**: マッピング済みである旨に更新。

## 実機検証

- `scripts/build_engine.py` で再ビルド(171 MB)→ handshake に全
  メソッド・caps(demucsAvailable=false, ffmpegAvailable=true)を確認。
- 強化後の smoke_engine を新バイナリに実行 → handshake ok /
  transcription ok(1 notes)で通過。
- Rust/Tauri 本体はこのマシンにリンク環境がないためビルド未検証 —
  変更は JSON/ドキュメント/Python のみ。

Closes #65
Refs #10
