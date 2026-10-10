## 背景

`swing-4-4` 行が唯一の非満点（onset F1 0.9375, med err 41.7ms）。pitch は 100% なので音符自体は正しい。

## 解釈

真値はスウィング八分（長短 2:1、offbeat は beat+1/3）。エンジンは straight 八分に記譜 + swing 指示（UI の buildSwingWarp で再生時にワープ）— 記譜上は正しい。ベンチの beat→sec 変換は tempoMap のみで swing ワープを適用しないため、offbeat が系統的に ~83ms ずれ（median 41.7 = onbeat 0ms と offbeat ~83ms の混在中央値）。fp/fn 各1 は境界の1件。

## 対応候補

- ベンチ側: swing 検出済みの行では beat→sec に swing warp を適用して真値と比較する（記譜意味論に合わせる）
- または onset F1 許容を swing 行だけ緩める

優先度: 低（計測モデルの整合問題）