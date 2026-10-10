## 問題

pYIN バックエンド (predict_note_events_pyin) は frames_to_note_events が返す
voiced_prob 平均をそのまま振幅として _to_raw_event に渡しており、
MIDI velocity が voiced_prob * 110 で決まる。

voiced_prob は「有声である確率」であり音量ではない。結果として、
ハッキリ歌われた小さい音は velocity が高く、息の多い大きな音は低い、
という逆転が起き、MIDI 書き出し・自動演奏の強弱が実際の演奏と合わない。
Basic Pitch 側の amplitude はモデルが推定した音の強さなので velocity の
代理として概ね妥当だが、pYIN の voiced_prob は意味が異なる。

## 対応案

- predict_note_events_pyin で各ノート区間の RMS を harmonic 波形から計算し、
  dBFS から velocity へのマッピングで実際の音量を反映する。
- confidence は従来どおり voiced_prob 平均を使う(検出確度の意味として正しい)。
- _to_raw_event に velocity オーバーライド引数を追加し、Basic Pitch 側の
  挙動は変えない。
