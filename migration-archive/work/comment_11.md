進捗・検証状況の記録 (2026-09-28):

**実装済み(本 issue のコード側は完結)**
- `tools::data_dir` — `HORNSCRIBE_DATA_DIR` / exe 隣の `data/` マーカー /
  プラットフォーム app-data、の3段で全書き込み先を解決(recordings,
  sources, source-refs.json, cache, autosave)。
- `tauri.bundled.json` が `resources/engine/*` → `engine/` と
  `resources/tools/*` → `tools/` を bundle.resources にマッピング済み。
- ポータブル zip 運用: exe 隣に `tools/` + `data/` を置けばインストーラ不要
  (exe-dir root が同じ解決規則で拾う) — PACKAGING.md 記載済み。

**実機検証の現状**
- 凍結エンジン exe (PyInstaller, 171MB) はビルド・handshake・全メソッド
  応答・demucs/ffmpeg 能力報告まで実機で確認済み(#10, PR #68)。
- `resources/tools/` に ffmpeg/ffprobe 実バイナリ配置済み。

**残ブロッカー(本機環境)**
- `cargo check` すら build script の link 段階で失敗: Build Tools 2022 は
  入っているが **VC++ ワークロード(VCTools)未導入で link.exe が存在しない**。
- 非管理者セッションのため VCTools 追加(UAC 必要)は実施不可 — ユーザーが
  一度 Build Tools installer で `C++ によるデスクトップ開発` 相当を追加する
  か、管理者権限で `setup.exe modify --add Microsoft.VisualStudio.Workload.
  VCTools` を実行すれば `npx tauri build --config src-tauri/tauri.bundled.
  json` の end-to-end 検証が可能になる。

コード・設定面で残る作業はなく、残りは環境依存の最終検証のみ。

