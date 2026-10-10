## 実機検証で確認（v0.2.7 ポータブル版）

`child.kill()` は PyInstaller onefile の **ブートローダー親** のみを終了し、実体の Python ワーカー（孫プロセス）を孤児化する。

### 検証

```
Stop-Process -Id 30300   # onefile 親を kill
→ 子 (python 実体, pid 43756) は継続生存
```

### 影響

- `engine_kill`（ハングジョブの terminate/restart）が実際にはワーカーを殺せない — ハングした採譜が孤児プロセスで**走り続ける**
- `kill_engine_on_exit`（アプリ終了時）も同じ — 孤児エンジンが ~300MB+ のメモリとキャッシュ/ログハンドルを保持し続ける
- handshake タイムアウト後の restart でも同様に孤児が残る

### 対策方針

- Windows: プロセスツリー kill（`taskkill /PID <pid> /T /F`、または Job Object）で子孫ごと終了
- onedir 化（別 issue）で単一プロセス化すれば構造的に根治
