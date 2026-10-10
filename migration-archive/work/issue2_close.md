PR #45 で残タスクをすべて消化しました。

- [x] リリース runbook 化: `docs/RELEASE.md` を新規作成。前提ツール確認 -> 検証ゲート (tsc / eslint / vitest / pytest / ruff) -> `scripts/build_engine.py` でエンジン同梱 -> `npx tauri build --config src-tauri/tauri.bundled.json` で NSIS ビルド -> ポータブル zip の手動ステージング -> タグ作成 -> `gh release create` でアップロード、までを一通り記載。
- [x] アップロードは手動 (`gh release` / Web UI フォールバック) と明記済み。
- [x] `docs/DEVELOPMENT_PLAN.md` セクション19 を Actions 不使用方針へ書き換え、旧 CI ワークフロー行は取り消し線+注記で履歴として残した。

クローズします。
