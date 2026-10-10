## 問題

#188 で導入した「テンポ倍/半分誤検出」のワンクリック修正（review の tempo_uncertain アクションと、プロパティパネルの ÷2/×2 ボタン）は、どちらも内部的に `setTempo` を呼んでいる。

しかし `setTempo`（`scoreedit._apply_set_tempo`）は tempo_map の BPM 値だけを書き換える「表示レベルの編集」であり、音符の記譜音価（start_beat / duration_beats / 小節区切り）は一切変えない。

## なぜこれが間違いか

テンポ推定が倍速を拾った場合（例: 実際は ♩=120 なのに ♩=240 と推定）、ビートマップは実際の8分音符ごとにアンカーを打つ。結果、実際の4分音符は 2 QL = 付点ではなく2倍の音価（例: 4分→2分）として記譜される。つまり **BPM が2倍になると同時に、音価も2倍に伸びており、秒ベースの再生時間だけは正しく保たれている**。

この状態で BPM だけを 240→120 に直すと:

- 記譜音価は2倍のまま → 楽譜は依然として間違い
- 再生は実際の半分の速度になる → 音源と合わなくなる

つまり現状のクイック修正は「表示上の BPM を直すだけで、肝心の音価を直さず、再生まで壊す」という最悪の組み合わせになっている。

## 修正方針

新しい score.edit 種別 `scaleTempo`（factor 指定）を追加する:

- tempo_map の BPM を factor 倍
- 全音符・休符の start_beat / duration_beats を 1/factor 倍（canonical beat 軸）
- pickup_beats、meter_changes（start_beat + measure_phase_beats）、key_changes、tempo_map の start_beat も同じ factor でスケール
- 音価が変わるため atoms は破棄し、新しいメーターマップで全パートを再タイル（set_meter と同じ _retile_window 経路）
- 秒ベースの再生時間は不変（正しい octave 修正の定義）
- レビュー issue の canonical_note_ids / time_range（秒）はそのまま有効

配線:

- tempo_uncertain のアクション: `setTempo(suggestedBpm)` → `scaleTempo(direction === "double" ? 2 : 0.5)`
- プロパティの ÷2/×2 ボタン: `setTempo` → `scaleTempo`（÷2/×2 の意味は「音価ごと直す」が自然。純粋なリネーム用途は自由入力フィールドに残す）

## 受け入れ条件

- scaleTempo(factor=0.5) 後、全音符の秒位置が不変、記譜音価が半分、BPM が半分
- undo/redo が既存スタックで動く
- ピックアップ・途中の拍子/調/テンポチェンジが正しくスケールされる
- MusicXML ラウンドトリップ検証が通る
