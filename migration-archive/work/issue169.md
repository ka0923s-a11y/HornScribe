## Basic Pitch の pitch bend(ビブラート/ポルタメント)を backend が捨てている

### 現状
domain/events.py の RawNoteEvent は pitch_bends: tuple[PitchBendPoint]
を持ち、シリアライズも往復する。しかし transcription/backend.py の
predict_note_events は Basic Pitch の note_events を展開する際に
for onset_s, offset_s, pitch_midi, amplitude, _bends in note_events: と
**bend を明示的に捨てて** RawNoteEvent に入れていない。

その結果:
- ボーカルのビブラート・しゃくり・ポルタメントという表現情報が
  エンジンの証拠として残らない。
- JPOP ボーカルの正確な楽譜化・自動演奏でのニュアンス再現の材料が
  失われている。

### 期待
RawNoteEvent.pitch_bends に Basic Pitch の bend を格納して証拠として
保持する。Basic Pitch の bend 値は MIDI pitch-bend 単位(0..16383、
センター 8192、±2 semitone レンジ)なので bend_semitones へ変換して
格納する。

### 後続(別途検討)
- MIDI export / オーディションへの bend 反映(表現力)
- ビブラートを「1 音の揺れ」として扱うクリーン/レビュー
この issue では証拠の保持までをスコープとする。
