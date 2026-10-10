## 概要

#251: 製品境界の「単一音源」「単一楽器」「1人で演奏可能」を分離して定義し、
chords/voices 出力がソロ演奏譜と誤認されないようにする。

## 変更

- `docs/PRODUCT_BOUNDARY.md`: 入力/出力楽器/演奏可能性の3軸を分離する節を追加し、
  出力モード表（ソロF管パート / 複数F管パート / 和音パート）を定義。
  総譜・多楽器行とコードネーム行の記述を新定義に整合。
- `ja.ts`: texture 選択に用途ベースの hint を追加
  - solo 系: 「1人のF管奏者がそのまま演奏できる譜面を作ります」
  - voices: 「複数の奏者向けの重奏譜です」
  - chords: 「1人で演奏する譜面ではありません」
- `ImportStates.tsx`: texture select に hint を接続（backendHint と同じ Field 機構）
- `pipeline.py`: chords 採譜のパート名を `Horn in F (chords)` に変更 —
  エクスポートされた MusicXML/PDF でも分析的出力であることが識別できる

## 検証

- 新規テスト `test_chords_texture_names_the_part_as_chords`: chords 採譜で
  単一パート + `(chords)` パート名が scoreDocument と MusicXML に出ることを確認
- `pytest tests/python` 全緑、`ruff`/`mypy` クリーン、`tsc`/`eslint` クリーン
