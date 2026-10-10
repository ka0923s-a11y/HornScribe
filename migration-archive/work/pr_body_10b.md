## 概要

Issue #10 の demucs 側を実装可能な状態にしました —— 凍結エンジンで
demucs が**構造的に到達不能**だった不整合を解消し、ffmpeg/ffprobe の
実バイナリ同梱もローカルで完了しています。

## 不整合(修正前)

- `isolate_demucs_vocals` は `sys.executable -m demucs` を spawn するが、
  凍結ビルドでは `sys.executable` = worker 本体。`-m` は PyInstaller に
  無視され、**第二の NDJSON worker が起動するだけ**で demucs は永久に
  動かない(しかも子プロセスの stdin が protocol パイプを共有し得る)。
- `_demucs_available()` / handshake の `demucsAvailable` は
  `find_spec` だけを見るため、ユーザーが自分の Python に
  `pip install demucs` してもパッケージ版では永久に false。

## 変更

- `vocal.py::_demucs_cmd()` を新設 —— 解決順序は `resolve_ffmpeg` と同型:
  `HORNSCRIBE_DEMUCS` 明示パス(不正パスは fallthrough せず missing)
  → 非凍結時のみ `sys.executable -m demucs` → PATH の `demucs` コンソール
  スクリプト(同梱 tools/ は shell が子 PATH に注入済み) →
  `HORNSCRIBE_PYTHON` / PATH python の find_spec プローブ。
  torch の import コストを払わないようプローブは `find_spec` ベース。
- demucs spawn に `stdin=DEVNULL` —— 子プロセスが protocol パイプを
  共有しないことを保証。
- handshake `demucsAvailable` を同一リゾルバに変更 —— バッジと実挙動が
  一致。
- `resources/tools/` に ffmpeg.exe + ffprobe.exe を配置(本機では
  gyan full build 8.1.1)、`*.exe` を gitignore、README/PACKAGING に
  essentials build 推奨・GPL ライセンス同梱・demucs.exe 同梱経路を明記。
- テスト: `_demucs_cmd` 解決順序 7 ケース追加、`TestDemucsSpanStaging`
  のスタブ更新。

## 検証

- pytest test_vocal 17件(3 skip=librosa要), test_worker 73件 pass
- ruff clean
- `scripts/build_engine.py` でエンジン再ビルド → 実バイナリ handshake で
  `demucsAvailable` が新リゾルバ経由で応答することを確認(結果は PR
  コメントに追記)
- Rust 側は変更なし(link.exe 不在で cargo build 不可のため既知)

Refs #10

