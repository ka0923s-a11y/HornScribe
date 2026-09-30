# リリース手順 (RELEASING)

`scripts/release.py` がローカル一発でデスクトップアプリ + 同梱エンジンを
ビルドし、NSIS インストーラーとポータブル zip を GitHub Release に
公開します。GitHub Actions は使いません(ワークフローは同梱せず、
検証・ビルド・タグ付け・公開のすべてをローカルで実行します)。

個別ステップを手動で回したい場合の内訳は `docs/RELEASE.md` に残して
あります(release.py がその手順をそのまま自動化したものです)。

## 前提

- バージョンは `apps/desktop/package.json` と
  `apps/desktop/src-tauri/tauri.conf.json` の `version` フィールドから
  読み取られます。**手入力のタグ名は使いません**。2つのマニフェストの
  version は一致している必要があります。
- Windows + Node/npm + Rust toolchain + `gh` CLI(ログイン済み)。
- エンジン frozen 化には PyInstaller 入りの venv(`.venv-bp312` 等。
  未検出時はスクリプトが探してエラーにする)。
- gnu toolchain でビルドする環境では `--toolchain gnu`
  (RUSTUP_TOOLCHAIN と rust-lld の RUSTFLAGS を cargo/tauri 工程に設定)。

## 手順

### 1. バージョンを上げる

前回のリリース以降に変更を積んだら、両方のマニフェストの `version` を
同じ値に上げてコミットします(例: `0.1.0` -> `0.2.0`)。

### 2. リリースを実行する

```powershell
python scripts/release.py            # 検証→ビルド→検査→公開まで全実行
python scripts/release.py --dry-run  # タグ/Release 作成の手前まで
```

スクリプトは自動で:

1. preflight — version 一致、gh CLI、同名 Release 無し、タグ衝突検査
2. テスト — frontend(typecheck/lint/vitest)、cargo check、pytest
3. frozen エンジン(PyInstaller, ~130 MB)をビルドし smoke テスト
4. `npx tauri build --config src-tauri/tauri.bundled.json` で NSIS
   インストーラー(エンジン + ffmpeg 同梱)
5. `scripts/package_portable.py` でポータブル zip(同梱 engine を
   もう一度 smoke してから zip 化)
6. 検証 — 両アセットが 50 MB 超、zip に engine/hornscribe-engine.exe
7. `v<version>` タグ作成→push、`gh release create --prerelease` で公開

既存アーティファクトを再利用するフラグ:
`--skip-tests` / `--skip-engine` / `--skip-tauri`
(アップロードだけ失敗した場合の再公開など)。`--yes` で公開確認を省略。

### 3. 成果物を検証する

- `*-setup.exe` と `*-portable.zip` が Release にあること
- 両方とも 50 MB 超であること(エンジン同梱の目安 — スクリプトの検証
  ステップが担保しますが、Release ページでも確認)
- ポータブル zip に `engine/hornscribe-engine.exe` が含まれること

## トラブルシュート

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `package.json X != tauri.conf.json Y` | version 不一致 | 両方を同じ値に |
| `tag vX already points at <sha>` | 同名タグが別コミット | version を上げる |
| `Release vX already exists` | 同名 Release あり | 消すか version を上げる |
| `no venv with PyInstaller` | エンジン venv 不足 | venv に `pip install pyinstaller` |
| インストーラーが小さい | エンジン未同梱 | `tauri.bundled.json` と resources を確認 |
| link エラー(gnu) | gnu toolchain | `--toolchain gnu` を付ける |

## 関連

- `docs/RELEASE.md` — release.py が自動化している各ステップの手動内訳
- `docs/PACKAGING.md` — 同梱エンジンの解決順・ローカルビルド
- `docs/ENGINE_RUNTIME_MATRIX.md` — 検証済みエンジンランタイム
- `.github/RELEASE_NOTES.md` — Release に貼るノート
