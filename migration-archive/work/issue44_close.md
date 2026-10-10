PR #46 で実装・マージしました。

**配線**: 和音マップは `ScoreDocument.chord_symbols`(beat座標・コンサート空間の `ChordSymbol`)としてドキュメントに載る。`raw_evidence` と同じくドキュメント直下の解析メタデータなので payload 外 = score revision を汚さず、`score.edit` の往復でも保持される。

**出力**: `_insert_harmony_symbols` が MusicXML 正規化時に `<harmony><root/><kind/></harmony>` を先頭パートのみに挿入。

設計判断(issueの検討点への回答):

- **F管版は移調済みシンボル**: 記譜音と同じ +P5 移調・同じフラット/シャープ方針で再スペル。奏者が読む調の中で和音が意味をなす、実在の移調パート譜と同じ作法。
- **小節途中の配置**: 非 `<chord/>` な `<note>`/`<direction>`/`<barline>` をアンカーに divisions カーソルを追跡(backup/forward 対応)。アンカーの無い位置は次のアンカーに負の `<offset>` で補正。
- **低confidence**: `chord_uncertain` と同じ床 (conf<0.35 or margin<0.04) を下回る区間は出力しない。除去された区間は同コード連続を分断し、再開時にシンボルを再掲する。
- **JPOP表記**: `kind@text` に `m7-5`/`maj7` 等の表記を保持 → ø/△ などの代替グリフに化けない。

検証: pytest 996件(+14新規)全パス、ruff クリーン。実機採譜(`.venv-bp312` + e2e_scale.wav)でドキュメント上4セグメントのうち contested-margin の1件が正しくフィルタされ、両エクスポートに3件の `<harmony>`。music21 での再パースも確認(C/G7/Am7/B半減、移調側 G/D7/Em7/F#半減)。

フォローアップ候補(別issue化するなら): アプリ内でのコード表示/手編集UI、`chord_uncertain` レビューでユーザが採用したコードを `chord_symbols` に書き戻す導線、スラッシュコード(分数和音)のテンプレート拡張。
