## 問題

pYIN バックエンド（#175）は単音トラッカーだが、テクスチャ設定（mono / melody / voices / auto）との組み合わせが検証されていない。

texture=voices で backend=pyin を選ぶと、警告なく単音の結果だけが返る。ユーザーは3声部の分割を期待しているのに、下声部は存在すらしない。auto でも同様で、多声ミックスを検出した場合の voices 提案（#148）と矛盾する。

## 改善案

- backend=pyin かつ texture が mono 以外の場合、ReviewIssue（新規 reason 例: monophonic_backend）を発行し「このエンジンは単音専用です。多声なら Basic Pitch を選んでください」と案内する
- または SettingsView で texture=voices 時に pYIN 選択を警告する
- 採用案は実装時に決定（レビューissue発行が製品の証拠提示ポリシーに合う）

## 受け入れ条件

- pyin + voices/auto で実行した場合、結果が単音であることがレビュー画面で明示されること
