## 症状

パッケージ版(installer / portable 両方)で、アプリを終了できない。

- タイトルバーの X / Alt+F4 / タスクバーの「閉じる」のいずれも一切反応しない(確認ダイアログすら出ない)
- 未保存・録音中・採譜中に出る終了確認ダイアログで「保存して閉じる」「破棄して閉じる」「採譜を中断して終了」等を押しても、ダイアログが閉じるだけでアプリは終了しない(無限ループ)
- タスクマネージャーから強制終了するしかない

## 根本原因

`apps/desktop/src-tauri/capabilities/default.json` が `core:window:allow-destroy` を付与していない。

`@tauri-apps/api` の `onCloseRequested` は内部実装として、ハンドラが `preventDefault()` を呼ばなかった場合に `this.destroy()` (= `plugin:window|destroy` コマンド)を呼んで実際にウィンドウを閉じる。このコマンドは `allow-destroy` に ACL ゲートされているため、権限が無いと reject されて**どの経路でもウィンドウが閉じない**:

1. クリーンな状態で X → close-requested → ガード不要 → API 内部の暗黙 `destroy()` → 権限拒否 → 無反応
2. ガード発動時に X → 確認ダイアログ → いずれの確定ボタンも `getCurrentWindow().destroy()` → 権限拒否 → ダイアログだけ閉じてループ

`onCloseRequested` リスナーが登録されている限り、Tauri は OS の close を Rust 側で抑止して JS 側の `destroy()` 呼び出しを待つ。#301/#400 のクローズガード導入以降、packaged 版は X では絶対に終了できない状態になっていた。

## 修正方針

- `capabilities/default.json` に `core:window:allow-destroy` を追加(本体の修正)
- 同種の再発に備えた防御: ACL の外にある app 固有コマンド `exit_app` (`AppHandle::exit(0)`) を Rust 側に追加し、フロントの確定終了パスを `destroy()` → 失敗時 `exit_app` フォールバックの `requestAppExit()` に集約
- `onCloseRequested` ハンドラは常に `preventDefault()` し、ガード不要時も自前の `requestAppExit()` で閉じる(= API 内部の暗黙 destroy に依存しない設計に変更)
- 回帰テスト: capabilities.json が `allow-destroy` を含むこと、および `requestAppExit` のフォールバック動作を vitest で固定

## 影響

クローズガード導入(#301/#400)以降のリリース全てで X / Alt+F4 / 確認ダイアログ経由の終了が失敗する、起動・終了系の致命的バグ。修正後は v0.2.6 として即リリースする。
