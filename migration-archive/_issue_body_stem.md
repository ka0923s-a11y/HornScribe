## 症状

`vocalIsolation` 有効時、demucs が利用可能な環境では分離に demucs が優先されるが、**入力の主旋律が人声でない**（シンセリード・ホルン等の楽器ソロ）場合、demucs は全エネルギーを `no_vocals` stem に逃がし、`vocals` stem として事実上無音（ソース RMS の −50dB 以下、分離残渣ノイズのみ）を返す。

この空の stem がそのままトラッカーに渡るため、採譜結果が壊滅する。

## 実測

合成フィクスチャ very-quiet-lead（-9.5dB SNR の埋もれた主旋律、38音）で検証:

| 分離方式 | pitchAcc |
|---|---|
| center extraction | 0.8947 |
| demucs（vocals stem） | **0.3421** |

stem RMS 比較（同一スパン）:

- center extraction: 0.154
- demucs vocals stem: 0.0002〜0.0007（残渣ノイズのみ）

## 影響

- `engine-vocal` extra 同梱のパッケージ版、または dev 環境で demucs が importable になった瞬間に全 vocalIsolation ジョブが対象
- ボーカル曲では demucs が優秀な分離を返す一方、**楽器ソロやシンセリードを採譜したいユーザーにとっては回帰**
- キャッシュにも無音 stem が残り、TTL 内は再利用される（悪い結果が永続化する）

## 対応方針

`vocal_wav` で demucs stem の RMS をソースの RMS と比較し、**デジタル無音に近くかつソースを大きく下回る** stem を棄却 → center extraction へフォールバックする。

- 埋もれた本物のボーカル（ミックス比 −20dB 級は実在する）を誤棄却しないよう、絶対閾値 AND 相対比の二重条件で判定
- キャッシュヒット時も再検査し、過去に保存された無音 stem を再利用しない（demucs 再実行はしない）
- ソースがデコード不能な場合は判定不能 → stem を維持（保守的）

親: #165（精度フロンティア計測中に発覚）
