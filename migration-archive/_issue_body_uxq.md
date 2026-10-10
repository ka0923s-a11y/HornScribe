## 概要

採譜オプションの「分離品質」（#181 で追加）は demucs 未導入環境では実質的に何も変えない — center extraction フォールバックにティアは無関係。しかし UI 上は有効なセレクトとして表示されるため、ユーザーは「高精度を選んだのに変わらない」と感じ得る仕様不整合。

## 実機で確認した点

- パッケージ版エンジンの capabilities は `demucsAvailable: false` を返している（handshake 応答で取得済み）
- demucs 不在時、vocalIsolation は center_extraction にフォールバックし、vocalIsolationQuality の値は品質に一切影響しない

## 対策案

- エンジン capabilities の `demucsAvailable` を UI に伝搬し、false の場合はセレクトを無効化 + 「このエンジンでは分離モデルが未導入のため標準のみ」とヒント表示
- vocalIsolation のヒントにも demucs 導入状態を反映（現状は固定文言）

## 境界

- demucsAvailable は handshake 後にのみ分かる — 初回表示は未判定として扱い、取得後に無効化する
