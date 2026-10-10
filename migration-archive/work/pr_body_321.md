## 概要

selection採譜で、whole-piece系ReviewIssue（meter_conflict / overlapping_candidates /
monophonic_backend / vocal_isolation_* / tempo_uncertain / swing_feel /
structural_measure_conflict）が `0.0〜元音源全長` を指していました。
10分音源の60〜90秒だけ採譜しても、ReviewBarの「元音源を再生」が0:00〜10:00へ飛んでいました。

## 変更点

- `analysis_range = TimeRange(selection_offset_sec, selection_offset_sec + len(samples)/sr)` を
  selectionスライス直後に定義し、全9箇所のwhole-piece `TimeRange(0.0, duration_sec)` を置き換え。
- `duration_sec` はソース全長としてmetaには残し、analysis scopeと分離（issueの要件どおり）。

## 検証

- 新規テスト `test_whole_piece_issues_span_the_selection_not_the_source`：
  [2,4]秒selectionで `overlapping_candidates` が 2.0〜4.0 を指し、
  note-idを持たない全issueがanalysis span内に収まることを確認。
- `pytest tests\python`：826件全パス。
- `ruff` / `mypy`：クリーン。

Closes #321
