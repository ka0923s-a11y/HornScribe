## 問題

採譜リザルトのレビュー issue の約 9 割が伴奏パート由来のノイズになっている。

リファレンス曲 (定テンポ JPOP 230s) の実測で:

| reason | lead | 伴奏 |
|---|---|---|
| outside_preferred_horn_range | 4 | **102** |
| low_model_confidence | 19 | **150** |
| very_short_detection | 0 | **22** |
| chord_uncertain | 7 | **21** |

伴奏合計 ~295 件 / lead 側の実質的な指摘は ~60 件。ホルン音域チェック (F1..A5 サウンディング) がピアノ伴奏の低音域 (MIDI 33-45) にまで適用され、ピアノとして正常な低音がすべて "ホルン音域外" としてフラグされている。

## 設計意図との不整合

#212 で「伴奏パートは分離由来なので per-note フラグではなく単一の accompaniment_part マーカー1つ」と明示設計されている。しかし _extra_issues が built.payload.parts の全パートを平坦化して per-note チェック (LOW_MODEL_CONFIDENCE / OUTSIDE_PREFERRED_HORN_RANGE / VERY_SHORT_DETECTION) を実行しているため、伴奏の ~3000 イベントから大量の誤報が生成される。

さらに伴奏の low_model_confidence は conf<0.3 で WARNING 扱いとなり、severity-priority キャップ (#272) で lead の本当の caution/info を omitted に押し出す。

## 修正方針

- _extra_issues は transposing=True のパート (= ホルン/lead スタッフ) の音符のみを対象にする。伴奏 (transposing=False) は従来通り accompaniment_part の単一 INFO マーカーのみ。
- Part.transposing の既存セマンティクスをそのまま使う (非移調スタッフ = 伴奏)。

## 効果 (リファレンス実測ベースの見込み)

surfaced+omitted の issue 総数 ~345 → ~60 台へ。レビュー作業者が実際に対処すべき lead パートの指摘が埋もれなくなる。
