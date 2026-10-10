## 問題

`swing_feel` 検出時の挙動が出力先で不一致:

- アプリ内自動演奏: `buildSwingWarp` で裏拍を遅らせて再生（#156）
- MusicXML: `<sound><swing>` ヒントを出力（#134）
- **MIDI エクポート: 何もしない — ストレートのまま書き出される**

「スウィング指示付きの楽譜」を書き出したのに、MIDI を再生するとストレートで鳴る。アプリ内試聴とエクスポート結果が食い違う製品レベルの不整合。

## 方針

`playback_midi_bytes` で `payload.swing_feel` があれば、音符の on/off ティックに swingWarp.ts と同じ位相ワープを適用:

- 各 canonical beat セル内で written phase 1/2 → sounding phase p
- セル境界（拍頭・小節線）は固定点 — 音符の順序は変わらない
- テンポマップ/拍子/調のメタイベントは拍頭固定なので変更なし

## 受け入れ条件

- swing_feel 付きスコアの MIDI で裏拍 onset が p 位相に移る
- straight（swing_feel なし）の MIDI 出力は現行と同一バイト
