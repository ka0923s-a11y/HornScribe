## 種別: バグ（採譜ジョブ全体が失敗）

`texture=chords` で採譜するとジョブが JOB_FAILED で落ちる:

    canonical rests do not tile measure 2: gap/overlap at beat 2 (next element at 3/2)

## 再現

bench `dyads-4-4` フィクスチャ（3度重音、texture=chords, 4/4@120）。
`python scripts/bench_transcription_e2e.py` で常時再現。

## 分析

多声部の残り休符タイルが canonical 検証を通らない。chords texture は
#155/#355 で入れた経路。単声部パスでは起きないため、重音を同一パートに
畳み込んだ際の休符生成（gap/overlap）が原因と思われる。beat 2 の位置で
休符が 3/2 に続く要素と衝突している。

ユーザーには「採譜に失敗しました」とだけ見え、原因は診断情報を見ないと
分からない — 和音素材で必ず落ちるなら機能が死んでいるのと同じ。
