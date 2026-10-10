## スコア編集後も自動演奏(オーディション)とスコアクロックが古い音符/長さのまま

### 現状
ScoreReadyWorkspace.tsx のマウント時に ScorePlaybackSynth を作り
synth.load(table, notesByCanonical) で音符を読み込み、
ScoreCursorClock を table.durationMs で生成している。

しかし音符編集系(音高・音価・分割/結合・タイ・休符→音符・リズム編集など
applyRhythmEdit 経由)は reloadEditedScore() で tableRef.current を
buildPlaybackTable(...) で再構築するだけで、

- synthRef.current.load(...) を再呼び出ししない
- ScoreCursorClock の durationMs も更新しない(コンストラクタ固定)

結果、**編集してもオーディションは編集前の音符を鳴らし続け、
楽譜の長さが変わってもクロックの総尺は古いまま**になる。
画面の楽譜は更新されるのに「聴こえる楽譜」が更新されない不整合。

### 期待
reloadEditedScore で tableRef を再構築したら:
- synth.load(新しい table, 最新の notesByCanonical) を呼んで
  オーディションを最新化
- スコアクロックの durationMs を新しい table.durationMs に更新
  (ScoreCursorClock に setDuration 相当を追加するか再生成)

### 影響
「生成した楽譜の自動演奏」が編集内容を反映しないため、
音高/リズムを直しても聴いて確認できない — 編集→確認の主目的ループが
成立していない。ユーザビリティ上の大きな不整合。
