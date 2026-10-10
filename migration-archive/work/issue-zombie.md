## 症状
ブラウザが採譜ジョブ実行中に閉じられると、dev エンジンブリッジ (apps/desktop/scripts/devEngineBridge.mjs) の /__engine/health が running:true を返し続けるが、実際の worker は既に死んでいる（ゾンビ）。この状態で新しい採譜を開始すると spawn が 409 で拒否され、ジョブは「採譜エンジンが応答していません」で死亡する。POST /__engine/kill で手動クリアすると復帰する。

## 期待動作
- worker プロセスの死亡を health が正しく検出する（pid 生存確認 / exit イベントで running フラグを落とす）
- ゾンビ状態で spawn が来たら自動で kill→再spawn するか、クライアント側 handshake タイムアウト後に自動リトライ
- ユーザーが手動で /__engine/kill を叩く必要がない状態にする

## 影響
dev 環境限定だが、ブラウザを閉じる・リロードするだけで発生しうる。リリース版（Tauri sidecar）でも同種のライフサイクル問題がないか src-tauri 側の worker 管理を併せて監査したい。

## 再現
1. dev bridge + vite dev を起動
2. wav をドロップして採譜開始
3. 採譜中にブラウザタブを閉じる
4. 再度開いて採譜を開始 → 409 / 応答なし
