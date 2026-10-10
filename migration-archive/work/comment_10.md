完了報告 (2026-09-28):

**ffmpeg/ffprobe 同梱**
- `resources/tools/` に ffmpeg.exe + ffprobe.exe (gyan full build 8.1.1) を配置。
  `resources/tools/*` → `tools/` の bundle マッピング + `resolve_ffmpeg` の
  同梱ルート解決 + エンジン子プロセスへの PATH 注入は既存のまま有効。
- `*.exe` を gitignore 化し、バイナリはコミットしない運用に(engine exe と同型)。
- README/PACKAGING に essentials build 推奨・GPL ライセンス同梱義務を明記。

**demucs 同梱経路(構造不整合の修正 — PR #68)**
- 旧実装は `sys.executable -m demucs` を spawn するが、凍結 exe では
  `sys.executable` = worker 本体のため**パッケージ版では demucs が構造的に
  到達不能**だった(第二 worker が起動するだけ)。
- `_demucs_cmd()` を新設し、HORNSCRIBE_DEMUCS → `-m demucs`(非凍結時) →
  PATH コンソールスクリプト(同梱 tools/ 含む) → HORNSCRIBE_PYTHON/PATH
  python の find_spec プローブ、の順に解決。ユーザーが自分の Python に
  `pip install demucs` すればパッケージ版でも無設定でニューラル分離が効く。
- demucs spawn に `stdin=DEVNULL` を追加(protocol パイプ共有の防止)。
- handshake の `demucsAvailable` を同一リゾルバに変更(バッジ=実挙動)。
- 再ビルドした実エンジンで handshake 確認: `demucsAvailable` が新リゾルバ
  経由で応答(本機では demucs 未導入のため false、ハンドシェイクも正常)。
- 完全オフライン選択肢として `tools/demucs.exe` 同梱経路を PACKAGING.md に
  明記(~1-2GB のため opt-in 維持)。

残タスクは #11 側(実 `tauri build` による end-to-end パッケージ検証 —
本機に MSVC リンカが無く Rust ビルド不可)に集約するため、本 issue は
クローズします。

