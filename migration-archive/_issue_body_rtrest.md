## 症状

伴奏パートを含むスコアの reviewIssues に structural_measure_conflict (warning) が出る。証拠の hythmRoundtripProblems は先頭で  event count 1734 != expected 1735 を報告し、以降 4,370 件の連鎖不一致（id ずれ・onset/duration 不一致）が続く。

## 原因

export 側の往復比較 erify_rhythm_roundtrip の非対称な休符扱い:

- canonical 側 (_expected_events) は ScoreRest を 1 件ずつ列挙する
- 再読込側 (_actual_events) は連続する休符を 1 つのスパンに**併合**する

実データ: canonical が rest[beat 17.25, +1/4] + rest[17.5, +1/2] を持つ区間を、reload 側は rest[17.25, +3/4] 1 件として返す。イベント数が 1 ずれた時点で zip 比較が以後全件ずれ、「reloaded id !=」「duration !=」のノイズに化ける。実際の発音（無音区間）は完全に等価で、エクスポート自体は正しい。

## 修正方針

- erify_rhythm_roundtrip で expected/actual 双方をソート後に休符スパンを併合（union merge: 端が接続または重複する rest を 1 スパンに）してから比較する。休符は同一性を持たずカバレッジのみ意味を持つため、併合は semantics-preserving。
- 併合後も残る差分のみを問題として報告。

## 効果

- リファレンス実測で part 1 の roundtrip problems 4,370 件 → 0 件（真の差分のみ残存する構造）。
- 複数レイヤを持つ伴奏譜面で毎回出る warning ノイズを解消。
