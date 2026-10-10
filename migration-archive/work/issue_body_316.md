実装レビューで発見した仕様の不整合（JPOP 精度に直結）。

vocalIsolation(#187) が成功すると、バックエンドへの入力はモノフォニックのボーカル推定になる。しかしバックエンド解決は `resolved_pyin = backend=="pyin" or (auto and texture=="mono")` のままで、分離済み入力にも Basic Pitch(ポリフォニックモデル)が走る。

pYIN は歌声・単旋律の追跡に向いたモノフォニックトラッカー(#175)。分離済みボーカルこそ pYIN が最も効く入力であり、現状は最適なエンジンが選ばれていない。

## 対応
- `vocal_isolation and vocal_path is not None`(分離が実際に成功)なら auto 解決で pYIN を選ぶ。明示的な backend ピン(basicPitch)は尊重する。
- `monophonic_backend` review issue は vocal isolation 経由の pYIN では発火しないよう条件を調整(分離済み入力では pYIN は正しい選択)。
