## 概要

`vocalIsolation=true` の採譜は環境によって実際の前処理が変わります
（demucs / center extraction / raw fallback）が、
`transcriptionRevision (tr-*)` は source hash + settings + backend のみから生成され、
実際に適用された isolation method / version を含んでいませんでした。
同じ音源・同じUI設定でも、環境差で全く異なる入力音声を採譜した結果が同じ `tr-*` を持ち得ました。

## 変更点

- `vocal_wav()` の戻り値を5要素へ拡張：`(path, reason, managed, method, method_version)`。
- `method_version()`：demucs は `importlib.metadata.version("demucs")`（torchをimportしない）、
  center_extraction はアルゴリズム定数 `_CENTER_EXTRACTION_VERSION = "1"`（変更時にbump）。
- `new_transcription_revision()` に `preprocess` 引数を追加 — 指定時のみ identity material に fold
  （非vocal job の tr-* は不変）。
- pipeline：vocalIsolation 要求時に `preprocess = {vocalIsolation, method, methodVersion, fallbackReason?}`
  を構築し revision へ渡す。result meta にも `preprocess` を記録（provenance復元用）。
- fallback（mono_source/unavailable）は `method: "none"` + `fallbackReason` で identity に含める。

## 検証

- `TestIsolationProvenance`（test_vocal.py）：method_version が demucs/center を正しく返す、
  revision が method・version・fallback で分岐、preprocess無しは従来通り。
- `TestVocalProvenance`（test_transcription.py）：meta["preprocess"] が記録、
  demucs/center/failed で tr-* が3種分岐、非isolation job の meta は clean。
- `pytest tests\python`（対象ファイル）：123件パス。`ruff`/`mypy`：クリーン。

Closes #319
