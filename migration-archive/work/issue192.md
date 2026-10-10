## 問題

#169 で RawNoteEvent.pitch_bends に保持した演奏ベンド（ビブラート等）が、clean.py のイベント再構築で全て失われる。

- clip_to_range: 選択範囲クリップ時に pitch_bends を引き継がない
- _extend: 同音マージ時にベンドを結合しない
- _replace_offset: 次ノートのオンセットでクリップする際にベンドを落とす
- _replace_pitch: オクターブ修正時にもベンドを落とす

結果として Basic Pitch / pYIN のベンド証拠が QuantizedNote に到達せず、MIDI書き出し・試聴のビブラート再現（#174）が実質無効化されている。

## 修正

- 再構築時に新スパン内のベンドを保持する（clip系は範囲フィルタ、mergeは結合）
- テスト: マージで両イベントのベンドが残る、クリップで範囲外ベンドが落ちる
