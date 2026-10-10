## 背景

`.github/workflows/ci.yml` は Python(ruff/mypy/pytest)のみを実行する。`apps/desktop` の TypeScript(tsc/eslint/vitest)と Rust(cargo check/test)は CI で検証されない。

## 問題

- FEAT-001 で追加した `src-tauri/src/capture.rs` はローカルに MSVC リンカが無い環境では `cargo check` すら通せず、コンパイル可否が CI でも確認されないまま main に入り得る
- フロントの型エラーや lint 違反も PR で検出されない
- 「実装はあるが誰もビルドしていない」状態が製品境界として放置されている

## 提案

- ci.yml に desktop ジョブを追加: `npm ci` → `tsc --noEmit` → `eslint` → `vitest run` → `cargo check`/`cargo test`(windows-latest)
- release.yml とは別に PR 時点でビルド可能かを担保する

## 関連

- #60 / PR #61(この PR で初めて検証不能な Rust コードが増えた)