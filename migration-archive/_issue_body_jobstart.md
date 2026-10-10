## 症状（v0.2.3 実機再現・ユーザー報告）

採譜実行で確定的に失敗: failure: transcriptionFailed (no response to 'job.start' within 10000ms)。直後に response for unknown id 'req-000002' dropped — エンジンは応答したがクライアントが先に諦めた。

## 根本原因

_handle_job_start が応答（accepted）を返す前に _warm_engine_imports() をメインスレッドで同期実行する。librosa.core.audio / librosa.beat / basic_pitch.inference のコールド import は PyInstaller 凍結環境で数十秒かかり、SidecarClient.requestTimeoutMs = 10s を必ず超過する。

- Windows の loader-lock 制約により当該 import はメインスレッド必須（ジョブスレッド不可）— コメントに明記済み
- job.start が pending の間は activeJobs が空なので watchdog は走らず、requestTimeoutMs のみが破綻点
- タイムアウト後に到着した応答が unknown id drop → 診断ログの散乱 + ユーザーは「理由不明の失敗」を見る

## 修正方針

job.start 専用の長めタイムアウト（jobStartTimeoutMs, 既定 120s）を SidecarClientOptions に追加し、startJob で使う。汎用 requestTimeoutMs（10s）は維持。

将来的な改善（別 issue 候補）: warmup の進行を job.event や stderr に出す / handshake への移動は watchdog・キャンセル経路の再検討が必要。
