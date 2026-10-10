## 概要

`texture=voices/chords` と `vocalIsolation=true` は意味が衝突していました。
voices/chords は「重なった複数ラインを残す」設定、vocalIsolation は「伴奏を落としてlead vocal中心にする」
前処理です。両方を選ぶと、voice_splitへ届く前に伴奏lineを削ってしまい、
設定値と成果物の意味が予測しづらい状態でした。

## 変更点

**エンジン（pipeline.py）**
- `texture in ("voices","chords")` かつ `vocalIsolation=true` の場合、`vocal_wav()` を呼ばず
  `vocal_reason = "polyphonic_texture"` を設定。
- `VOCAL_ISOLATION_UNAVAILABLE` issue を `detail: "polyphonic_texture"` で発行
  （mono_source/unavailableと同じreason、detailで区別）。
- `preprocess` provenanceに `method: "none"` + `fallbackReason: "polyphonic_texture"` を記録。

**UI（ImportStates.tsx / ja.ts / ScoreReadyWorkspace.tsx）**
- voices/chords選択時、vocalIsolation checkboxを `disabled` にし、
  `vocalIsolationPolyphonicHint` で理由を説明（黙って無効化しない）。
- `reasonDetail` に `polyphonic_texture` 分岐を追加し、
  `ja.reviewEvidence.vocalIsolationPolyphonic` で専用の日本語detailを表示。

## 検証

- `TestVocalPolyphonicConflict`：voices + vocalIsolation で vocal_wav が呼ばれず、
  `polyphonic_texture` issue + provenance が記録。melody texture は従来どおり分離。
- `pytest tests\python`：835件全パス。`tsc`/`eslint`/`vitest`（対象ファイル）：クリーン。

Closes #322
