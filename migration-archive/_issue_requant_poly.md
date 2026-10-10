## 症状

和音を含むマージパート（chords テクスチャの Horn in F (chords) パート、#213 のマージ伴奏パート）に対して設定変更由来の requantize（apply_score_edit kind=requantize）を実行すると、同時発音が消えて単旋律化する。

## 原因

_requantize_from_events（scoreedit.py）は raw_evidence のイベント列をそのまま quantize_events に通す。DP は単声部前提（各ノートは次オンセットで終わる e <= q 規則）なので、同時発音イベントは位置がデデュープ/微調整され、和音が逐次ノートに崩壊する。

通常の採譜パイプラインは split_voices でモノフォニック声部に分けてから各々を量子化し、build でマージしている。requantize 側にはこの再分岐が無い。

## 影響

- chords テクスチャで採譜 → 量子化設定（minDurationQl 等）を変更 → 和音が失われる
- #213 マージ伴奏パートも同様（エビデンスに和音イベントを含む）

## 対策案

エビデンスに重複オンセット（ポリフォニー）を含むパートは、requantize 内で split_voices で声部に再分割 → 各声部を同一アライメントシフトで個別量子化 → ノートをマージ → _layer0_gap_rests でレイヤー0の穴埋め、と通常パイプラインをミラーする。transposing=False 等のパート属性でなく「エビデンスが重複オンセットを含むか」で判定すれば chords テクスチャと伴奏パートの両方をカバーできる。

## 補足

単声部パートは従来どおり。分離した声部でクリーニング（clean_monophonic）も通すかは要検討（通常パイプラインと揃えるのが理想）。
