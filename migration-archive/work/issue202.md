## 問題

`docs/ENG-002-transcription-pipeline.md` が実装と乖離している:

- 「audio file -> Basic Pitch note events」とあるが、#175/#189 で pYIN バックエンドと texture-aware な auto 解決が入った（`backend` オプション、mono → pYIN）
- transcribing ステージが `basic_pitch predict` 固定と書かれている
- Known limits に「Monophonic sources only; polyphonic input yields a single line」とあるが、#85 の voices texture（最大3声部）と melody texture が既に実装済み
- tempo octave 検出 (#188) / scaleTempo (#198) / monophonic_backend 警告 (#181) など最近のレビュー理由も未記載

`docs/ENGINE_RUNTIME_MATRIX.md` も Basic Pitch のみの記述。pYIN（librosa 依存、モデル不要・完全無料）が第2バックエンドであることを一言補足する。

## 方針

- ENG-002: バックエンド選択（auto → texture 連動）、voices/melody/mono texture、pYIN 経路、最近のレビュー理由を追記。Known limits を現状に合わせる
- ENGINE_RUNTIME_MATRIX: pYIN の存在と依存（librosa のみ、ONNX モデル不要）を注記
