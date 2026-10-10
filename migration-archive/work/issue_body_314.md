実装レビューで発見した機能候補（JPOP 精度・ユーザビリティ）。

ミックス検出時（overlapping_candidates / auto_mix_detected）の remedy は現在 `複数声部として採譜`(voices) のみ。しかし JPOP の典型的ケースは「伴奏+リードボーカル」で、欲しいのは複数声部ではなく**主旋律の分離**。

#187 で実装済みの vocalIsolation は opt-in で、ミックス検出時に提案されないため、ユーザーがその存在に気づかない。

## 提案
overlapping_candidates issue に `suggestVocalIsolation: true` evidence を付け（vocalIsolation 未使用時のみ）、レビューアクションに「ボーカル分離で採譜し直す」(vocalIsolation+melody) を追加する。voices 提案と併記し、ユーザーが目的に応じて選べるようにする。
