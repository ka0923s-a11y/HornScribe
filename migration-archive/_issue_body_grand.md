## 症状

伴奏パート（Pno）が MIDI 33〜88 の広音域を単一ト音譜表に詰め込んでおり、低音域の音符が大量の加線で譜面外にはみ出し読みにくい。ピアノ伴奏としては大譜表（ト音＋ヘ音の 2 段）が自然。

## 改善案

- accompanimentPart ON 時、伴奏パートを大譜表（treble + bass）でレンダリングする。
- 音符の割り当ては可変しきい値（例: C4=60 未満は bass、または和音単位でまとめて割り当て）で行い、MusicXML では 1 part・2 staves（<staves>2</staves>）として出力。
- 段の割り振りに迷う和音は時間位置でスナップ（同一 onset の塊を分割しない）。

## 代替案（小さく始めるなら）

- 単一譜表のまま、低音域まとまり区間だけヘ音記号に切替（clef change）。verovio/MusicXML とも対応可能。

## 対象

- notation/to_music21.py（part 構築）、export/musicxml.py（staves 出力）、GUI の譜面表示（verovio は大譜表を標準対応）。
