GUI_UX_SPEC §13 の MVP後 項目。簡易音符修正の残り:

- **split** — 1音符をグリッド上で2つに分割（同ピッチ・タイなし or タイあり選択）
- **merge** — 隣接する同ピッチ2音符を1つに結合（実質 tie toggle の逆操作に近いが、タイでなく音符自体を併合）

score.edit への追加 kind として実装可能（setDuration/toggleTie と同じ re-tile 経路）。merge は toggleTie（解除側）と結果が近いため、UI 上の区別（タイ解除=記譜上の分割維持 vs merge=1音符化）を整理してから着手するのがよい。

