PR #43 で検証基盤を入れました。状況メモ:

## 完了した部分

- **自動ティア**: `tests/python/test_musicxml_roundtrip.py`(11件) — 検証ホストに MuseScore が無いため、同じ partwise 4.0 文法を読む music21 インポータで往復検証。小節/音符/休符/タイ/和音/臨時記号の綴り/途中調号・テンポ変化/スウィング表示/複数パート/F管移調が**欠落・変形なく往復**することを確認。今後の回帰はこのテストが拾う
- **手順書**: `docs/MUSESCORE_ROUNDTRIP.md` — 自動ティア済み範囲と MuseScore GUI チェックリスト(実機確認項目・報告先・既知の非対象 `<harmony>`/表情記号)を記録
- **exporter 修正**: 不要と判明(全要素クラスが往復したため)

## 残り(オープン理由)

- MuseScore 本体での GUI 確認のみ残存。検証ホストに MuseScore 未導入のため実施できず。MuseScore 導入機で `docs/MUSESCORE_ROUNDTRIP.md` のチェックリストを実行し、結果をこの issue に追記すればクローズ可能

## 検出した関連候補

- コードシンボル `<harmony>` 未エクスポート — #3 の `chordProgression` を将来接続する候補(別issue化の余地あり)
