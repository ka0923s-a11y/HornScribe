## 音符の追加（休符→音符変換）ができない — 検出漏れの修正手段がない

### 背景

score.edit の語彙は既存ノートの編集（setDuration/shiftOnset/
toggleTie/splitNote/mergeNotes/ピッチ・削除・異名同音）と譜面全体の
操作（setTempo/setMeter/setKey/keyChangeAt/requantize）をカバーする
が、**新しい音符を追加する手段がない**。basic_pitch が拾い損ねた
音符（JPOP の弱いアタック・伴奏に埋もれた一音）は、現状では
「再採譜するしかない」= 検出漏れを直せない。一般 JPOP の完全な
楽譜化を目指す上で最大の修正機能ギャップ。

### 提案する設計（スコープを絞った実現可能な形）

自由位置への挿入は小節再分割（re-barring）を伴い大きすぎる。
実用上の主ケースは「休符であるべきでなかった場所に音符がある」
なので、**休符スパンを音符に変換する**形に限定する:

- 新しい score.edit kind: restToNote { partId, startBeat, pitchMidi,
  durationBeats? }。startBeat を含む休符スパンを見つけ、新しい
  QuantizedNote に置き換え、前後の残りを再タイリングする
  （既存の _part_content rest 計算がそのまま使える）。
- タイミングは変わらないので小節構造・他ノート・tempo map は無傷。
- UI: 休符をクリック選択 → 「音符に変換」コマンド。初期ピッチは
  直前ノートのピッチ（ユーザーは既存のピッチ編集で調整）。
  durationBeats 省略時は休符スパン全体。

### 受け入れ条件

- score.edit restToNote が canonical payload を更新し、新しい
  scoreRevision + 両 MusicXML を返す。
- 休符スパンが新音符 + 残り休符に正しく再タイリングされる
  （分割位置・barline 越えなし）。
- 選択した休符に対してコマンドが有効化され、undo が効く。

### メモ

- 自由位置挿入（後続をシフトする挿入）は別途検討 — 拍子内の
  リズムを壊すため MVP では扱わない。
