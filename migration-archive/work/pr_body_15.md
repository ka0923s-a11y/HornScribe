## 概要

Issue #15「MusicXML エクスポートの MuseScore 往復検証」を実機で完遂し、
再現可能な一括検証スクリプトとして固化しました。

## 実施内容

- `scripts/musescore_roundtrip.py` を新設:
  MuseScore 4 バイナリを `-o` ヘッドレス変換モードで起動し、
  `fixtures/musicxml` 配下の全ゴールデンについて
  MusicXML → .mscz → MusicXML の往復を実行。
  小節数 / 音価付き音符数 / (ピッチ, 音価) 集合の一致を
  music21 で検証し、不一致・インポート失敗で終了コード 1。
- 実機検証: MuseScore Studio 4.7.5 (portable) にて
  **18/18 全 fixture clean** — インポート可否と構造的往復一致を確認。
- `docs/MUSESCORE_ROUNDTRIP.md` を更新:
  「検証ホストに MuseScore が無い」旨の但し書きを撤去し、
  自動化済み項目と残る GUI 目視項目を明記。

## 検証

- 本スクリプトで 18/18 clean
- `ruff check` clean

Closes #15
