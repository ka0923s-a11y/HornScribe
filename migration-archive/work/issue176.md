## pitch_spelling_ambiguous レビューで「異名同音を切替」アクションを出す

### 現状
#166 で調外音に pitch_spelling_ambiguous issue が出るようになった。
しかしレビューバーのアクション導線は suggestVoicesTexture 専用で、
表記の曖昧さを解消する手段がレビュー画面から見えない。

レビューバーには音高 +/- ボタンがあるが、それは sounding pitch を
変える操作 — 表記問題(同じ高さの綴り違い)には誤った操作を
提示している。正しい解決は選択音符の異名同音トグル(E キー、
toggleEnharmonic)だが、レビュー文脈ではその存在が分からない。

### 期待
pitch_spelling_ambiguous issue に対して「異名同音を切替」
(= toggleEnharmonic と同じ効果)をレビューアクションとして出す。
issue の actionLabel/onAction 枠組み(suggestVoicesTexture で使用中)
を拡張して、reason ごとに適切なアクションを選べるようにする。

### ユーザビリティ
「要確認 → その場で直せる」ループが表記問題でも成立する。
