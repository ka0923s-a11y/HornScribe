## pitch bend を canonical → MIDI export / オーディションへ伝播して表現力を出す

### 背景
#169 で Basic Pitch の pitch bend(ビブラート/ポルタメント)を
RawNoteEvent.pitch_bends に保持するようにした。ただし RawNoteEvent は
ジョブ内の一時的な証拠で、canonical QuantizedNote には伝播しないため、
現状では bend は採取されるが楽譜・MIDI・自動演奏のどこにも現れない。

### 現状のギャップ
- QuantizedNote に bend を持たせる仕組みがない(スキーマ追加が必要)
- MIDI export (export/midi.py) は pitch_bend メッセージを出さない
- オーディション (playbackSynth.ts) はオシレータ周波数を固定で、
  ビブラートを再生しない

### 期待(段階的)
1. QuantizedNote(または note 単位の別エンティティ)に bend を伝播
   — scorebuild で代表 bend を集約し canonical payload に保持。
   スキーマバージョン/シリアライズの互換に注意。
2. MIDI export に pitch_bend メッセージを出力(ボーカルの揺れが
   外部 DAW/シンセで再現される)。
3. オーディションのオシレータ周波数を bend カーブで変調
   (ビブラートが聴こえる)。

### 精度との関係
JPOP ボーカルの「完全に正しい」再現には音の高さだけでなく揺れの表現が
含まれる。まず証拠(#169)を確保したので、次はそれを活かす段。

### 注意
完全無料運用を維持: 追加の外部サービスや有料モデルは使わず、
既存の Basic Pitch 出力と Web Audio / MIDI で実現する。
