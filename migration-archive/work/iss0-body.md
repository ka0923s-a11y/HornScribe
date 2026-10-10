## 背景

FEAT-001(#60, PR #61)で追加した録音取り込みは、録音データをメモリ上の Blob として `RecordedAudioRef` で保持する。ディスク上の実ファイルを持たないため、`sourceAudio.originalPath`/`contentHash` を起点とするプロジェクト保存・SOURCE_MISSING リリンク UX(FND-001 スキーマ)の対象外になっている。

## 問題

- 録音→採譜→プロジェクト保存→再開すると、音源が「録音」であることを復元できない(再現性の断絶)
- ユーザーが録音テイクを後から聴き直す手段がない
- `LoadedAudio.ref` の union に recording が混ざったことで、path 前提のコード(FND-001 由来)との境界が曖昧になった

## 提案

1. 録音完了時に `appDataDir/recordings/` へ WAV を自動保存し、`RecordedAudioRef` に `path`/`contentHash` を持たせる(通常ファイルと同じリリンク経路に乗せる)
2. または録音を「一時ソース」として正式に型付けし、プロジェクト保存時に「音源をファイルに保存しますか?」を尋ねる

GUI_UX_SPEC §3 の「ユーザーのファイルは読み取り専用」との整合:録音物はユーザー所有ファイルではなくアプリ生成物なので、appDataDir への保存は境界を侵さない。

## 関連

- #60 / PR #61(FEAT-001 実装)
- FND-001 project schema v1