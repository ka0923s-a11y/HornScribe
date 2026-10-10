## 解決

PR #178 で修正し、v0.2.6 としてリリース済み。

- 根本原因: `capabilities/default.json` に `core:window:allow-destroy` が無く、`onCloseRequested` リスナー経由の全ての close 経路(API 内部の暗黙 `destroy()` と確認ダイアログの各確定ボタン)が `plugin:window|destroy` の権限拒否で失敗していた
- 修正1: `core:window:allow-destroy` を付与
- 修正2(防御): app 固有コマンド `exit_app` (`AppHandle::exit(0)`、ACL の外)を追加。確定終了は `requestAppExit()` = `destroy()` → 失敗時 `exit_app` に集約し、権限回 regressions でも終了不能にならない設計に変更
- 修正3(設計): `onCloseRequested` は常に `preventDefault()` し、ガード不要時も `requestAppExit()` で閉じる(API 内部の暗黙 destroy への依存を排除)
- 回帰テスト: `capabilities.test.ts`(grant 固定) + `exit.test.ts`(フォールバック) を追加

検証: vitest 13 件パス / tsc / eslint / cargo check(gnu, link-self-contained) パス。
リリース: https://github.com/ka0923s-a11y/HornScribe/releases/tag/v0.2.6 (setup.exe 368.7 MB + portable.zip 389.7 MB)
