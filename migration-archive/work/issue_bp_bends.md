basic_pitch の `pitch_bends` を MIDI ワイヤー形式(8192 中心 / 4096=1半音)としてデコードしているが、実際には **contour-bin 単位(1/3 半音刻み、0 中心)** が返ってくる。

結果として basic_pitch 経路の採譜では全ノートの `bendSemitones` が `v=0 -> (0-8192)/4096 = -2.0` に潰れ、コミット済みフィクスチャ `canonical_scale_doc.json` でも全ノート -2.0st 一定の値が観測できる。ビブラート等の実際の揺れも完全に潰れる。

## 影響

- 楽譜の `pitchBends` 証跡が意味をなさない(常に -2st フラット)
- MIDI エクスポートのピッチベンドも -2st に沈む
- #427 の連続 F0 証跡オーバーレイで「検出ミス」に見える表示になる

pYIN 経路(`frames_to_note_events` が 8192 中心の MIDI tick を合成)は正しくデコードされており、バックエンド間でエンコード規約が混在しているのが根本原因。

## 修正方針

`_bend_points` / `_to_raw_event` に単位パラメータを追加し、`predict_note_events`(basic_pitch)側は `v / CONTOURS_BINS_PER_SEMITONE` でデコードする。フィクスチャは逆変換で再生成する。
