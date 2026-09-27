# MuseScore ラウンドトリップ検証手順

MusicXML エクスポートが MuseScore で正しく再読込されるかの検証手順。自動テスト(`tests/python/test_musicxml_roundtrip.py`)は music21 インポータで同じ partwise 文法の往復を常時検証している。本書は MuseScore 本体での確認点をまとめたもの。

## 前提

- MuseScore 4.x(または 3.6+)がインストール済みであること。`detect_tools` は PATH → `C:\Program Files\MuseScore 4\bin\MuseScore4.exe` の順に探す
- HornScribe で採譜済みの楽譜、または `fixtures/musicxml/` のゴールデン

## 自動テストが保証していること(手動再確認の不要な範囲)

- MusicXML 4.0 partwise 形式でパース可能(全 shape でクラッシュしない)
- 小節数・音符・休符・和音構成音・タイ断片の欠落なし
- 臨時記号の表記が調性どおり往復する(フラット調→フラット、シャープ調→シャープ)
- 途中の調号変化・テンポ変化が正しい小節に入る
- スウィング表示(「Swing」テキスト + `<sound><swing>` ヒント)がパース後も残る
- 複数パート・F管移調記述(書き下ろし↔実音の往復)

## ヘッドレス一括検証(自動化済み — #15)

実機の MuseScore バイナリがある環境では `scripts/musescore_roundtrip.py` が
全ゴールデンの import → .mscz → MusicXML 再書き出しを一括で回し、小節数・
音価付き音符数・(ピッチ,音価) 集合の一致まで検証する:

```powershell
python scripts/musescore_roundtrip.py path/to/MuseScore4.exe
```

2026-09-28 実施結果: MuseScore 4.7.5 で 18/18 clean(全 shape で往復一致)。
このスクリプトでカバーされる「インポート可否 + 構造的往復一致」は手動
再確認不要。残るのは GUI 目視項目(Swing 表示の見え方・パレット警告・
臨時記号の見た目)のみ。

## 手動確認チェックリスト(MuseScore GUI)

1. エクスポート: アプリの書き出しダイアログから MusicXML を保存(コンサートピッチ版と F管版の両方)
2. 開く: MuseScore にドラッグ&ドロップ、または HornScribe の「MuseScoreで開く」(MuseScore 検出時)
3. 確認点:
   - 音符・休符・タイ・和音が自動テストと同数・同位置に見える
   - 小節数と拍子記号が一致(途中の拍子/調号/テンポ変化が正しい小節に入っている)
   - 臨時記号が調性に沿って自然に見える(異名同音の奇妙な表記がない)
   - 「Swing」表示と再生時のスウィング感(2:1 比率)
   - F管版は書き下ろし譜として読める(実音コンサート版とは五度ずれた表記)
   - パレット警告や「不明な要素」ログがインポート時に出ない
4. 変形・欠落があれば: 該当小節番号・要素種別・期待値を issue に記録し、`export/musicxml.py` 側を修正(検証観点は importer 差異より生成物の妥当性)

## 既知の非対象

 - コードシンボル(`<harmony>`): #44 でエクスポート済み。`ScoreDocument.chordSymbols`(採譜ジョブの和音マップ)が存在し、かつ confidence/margin が `chord_uncertain` の閾値を上回る区間のみ出力される。F管版は記譜音と同じく五度上の書き下ろしコード名になる。round-trip 検証時は小節頭のシンボル表示と `<offset>` による小節途中の配置も確認対象
- 強弱記号・スラー等の表情記号: 採譜出力には含めていない

## 記録ルール

- 手動検証を行った場合は、MuseScore バージョン・対象スコア・結果を issue #15 へ追記する
