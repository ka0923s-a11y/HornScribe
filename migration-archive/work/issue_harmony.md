MusicXML コードシンボル(`<harmony>`)エクスポート

## 背景

#3 で `meta.chordProgression`(小節セグメント化された和音マップ)がエンジン出力に入ったが、MusicXML への出力は未接続。MuseScore 等で開いた時にコード記号が譜面上に出れば、採譜結果の確認・演奏補助として価値が高い(#15 の既知非対象としても記録済み)。

## やりたいこと

- `chordProgression` を `<harmony><root/><kind/></harmony>` として小節先頭に出力(コンサート版・F管版どちらにも。F管版は移調後のコード名にするか、実音コードを併記するか設計を決める)
- セグメントが小節途中から始まる場合の配置ルール(拍位置の `<offset>` 利用)
- 低confidence セグメントの扱い(出力しない/括弧付き表示など、閾値は要検討)

## 補足

- 現状 chordProgression は job result meta のみ。canonical payload への引き回しか、エクスポート時のオプション入力かが設計分岐点
- 関連: #15(MuseScore round-trip), #3(chord map)
