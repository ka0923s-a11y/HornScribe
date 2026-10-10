追試（demucs `--two-stems=other` 経路の検討）:

「vocalIsolation を声でない主旋律に使う」ケースでは `--two-stems=vocals` が空 stem を返す（#169 でフォールバック済み）が、`--two-stems=other` なら楽器主旋律が残る可能性があるため実測した（very-quiet-lead, 本番 auto+iso 経路に other stem を注入）:

| stem | pitchAcc | miss | xtra | F1 | det |
|---|---|---|---|---|---|
| center extraction | **0.8947** | 3 | 3 | 0.8947 | 38 |
| demucs other | 0.8684 | 1 | 6 | 0.9383 | 43 |

other stem は drums+bass を除去する一方、pad は主旋律と同じクラス側に残るため誤検出が増え、仲裁問題は解消しない（pitchAcc は低下）。**demucs 第2パス導入は見送り** — 分離コスト2倍に対し合成ベンチ上の利益なし。実ボーカル素材での vocals stem の優位も引き続き選択済み（demucs 優先 → 無音なら center）。

残る改善余地は「分離品質」ではなく -9.5dB での誤ピッチ仲裁そのものであり、現行の free スタックでは LOW_MODEL_CONFIDENCE 系の要確認提示でユーザーに委ねる設計が妥当。
