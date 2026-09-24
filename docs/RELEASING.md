# リリース手順 (RELEASING)

`release.yml` が Windows ホストランナーでデスクトップアプリと同梱エンジンを
ビルドし、NSIS インストーラーとポータブル zip を GitHub Release に公開します。

## 前提

- バージョンは `apps/desktop/package.json` と `apps/desktop/src-tauri/tauri.conf.json` の
  `version` フィールドから読み取られます。**手入力のタグ名は使いません**（#266）。
- 2つのマニフェストの version は一致している必要があります。

## 手順

### 1. バージョンを上げる

前回のリリース以降に変更を積んだら、両方のマニフェストの `version` を同じ値に
上げてコミットします（例: `0.1.0` -> `0.2.0`）。

### 2. リリースを実行する

GitHub → Actions → **Release** → **Run workflow** で対象ブランチ（通常 `main`）を
選んで実行します。`v*` タグの push でも起動します。

ワークフローは自動で:

1. `guard` — 同名の GitHub Release が既にあればスキップ（冪等）
2. タグ名を `v<version>` に解決し、既存タグが別コミットを指していれば失敗
3. フロントエンド / Rust / Python エンジンのテストを実行
4. frozen エンジン（PyInstaller, ~130 MB）をビルドし smoke テスト
5. NSIS インストーラーとポータブル zip をビルド（エンジン同梱を検証）
6. `v<version>` タグをビルドしたコミットに作成して push
7. GitHub Release にアセットを公開（`--prerelease`）

### 3. 成果物を検証する

- `*-setup.exe` と `*-portable.zip` が Release にあること
- 両方とも 50 MB 超であること（エンジン同梱の目安 — 50 MB 未満なら同梱漏れ）
- ポータブル zip に `engine/hornscribe-engine.exe` が含まれること

## トラブルシュート

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `package.json X != tauri.conf.json Y` | version 不一致 | 両方を同じ値に |
| `tag vX already exists on <sha>` | 同名タグが別コミット | version を上げる |
| Release が作成されない | guard が skip | 既存 Release を消すか version を上げる |
| インストーラーが小さい | エンジン未同梱 | `tauri.bundled.json` と resources を確認 |

## 関連

- `docs/PACKAGING.md` — 同梱エンジンの解決順・ローカルビルド
- `docs/ENGINE_RUNTIME_MATRIX.md` — 検証済みエンジンランタイム
- `.github/RELEASE_NOTES.md` — Release に貼るノート
