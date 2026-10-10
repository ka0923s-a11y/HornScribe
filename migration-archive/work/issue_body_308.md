実装レビューで発見: `protocol/PROTOCOL.md` の `transcription` job.start params 表が実装と食い違っている。

欠けているもの:
- `vocalIsolation` (bool, #187) — 実装済み・options.py でパース済みだが文書にない
- `displayName` (string, #305) — スコアタイトル用のユーザーファイル名
- `texture` の `"chords"` 値 (#155/#251) — 表は auto/mono/melody/voices のみ

実装(options.py)が真実なので文書を追いつかせる。
