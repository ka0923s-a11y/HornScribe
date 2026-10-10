実機検証 (2026-09-28, MuseScore 4.7.5 / PortableApps 版 x86_64):

`fixtures/musicxml/` の全 18 ゴールデンを MuseScore バイナリで
import → .mscz → MusicXML 再書き出しし、music21 で原フィクスチャと
比較した。

結果: **18/18 clean**

- 全フィクスチャが MuseScore でエラーなくインポートできる(exit 0、
  変換成功)。
- 往復後の小節数・音価付き音符数・(ピッチ, 音価) 集合が全
  フィクスチャで原物と一致 — 音符・休符・タイ・和音・拍子/調号変化・
  移調記述の欠落なし。

ヘッドレス CLI(`MuseScore4.exe -o`)で実施したため、GUI 側の目視項目
(Swing 表示の見え方・パレット警告・臨時記号の見た目)は未確認。
それ以外の round-trip 完全性はこれで担保されたと判断し、本 issue は
クローズする — GUI 目視で問題が見つかった場合は別 issue で追う。

検証手順は `scripts/musescore_roundtrip.py` として恒久化した(次の
リリースでも同じチェックが回せる)。
