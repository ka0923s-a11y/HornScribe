## 背景
設定 → 詳細設定 に「採譜エンジン」(auto / Basic Pitch) の select があり、`AppSettings.backend` として永続化される。

## 不整合
この設定値はどこにも配線されていない:
- `buildTranscriptionParams` が `backend` を job.start params に含めない
- `TranscriptionParams.from_payload` (options.py) に `backend` パラメータ自体が存在しない

つまり UI 上の選択は何も変えない dead setting。ユーザーが "Basic Pitch" を明示しても "auto" を選んでも動作は同一。

## やりたいこと
- `backend` を job.start params → `TranscriptionParams` → meta.settings に配線 (将来の複数バックエンドに備えた契約として)
- "auto" は現状 basic_pitch に解決されることを meta で正直に記録
- もしくは UI から削除 (配線が望ましい)
