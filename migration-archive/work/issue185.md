## 問題

ScoreDocument.transcriptionBackend / transcriptionBackendVersion が scorebuild.py 内で "basic_pitch" / "0.4.0" にハードコードされている。pYIN バックエンド（#175）で採譜しても、プロジェクトファイルと scoreDocument の provenance が basic_pitch と誤記録される。

meta.backend は正しく解決されているのに、ScoreDocument 側が嘘をつく不整合。

## 修正

- build_score に transcription_backend / transcription_backend_version kwargs を追加
- pipeline で解決済みの backend_id / backend_version を1箇所で計算し、ScoreDocument と meta の両方に流す
- テスト: pyin ジョブで scoreDocument.transcriptionBackend == "pyin" を検証
