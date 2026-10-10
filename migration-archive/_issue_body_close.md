## 症状

ウィンドウの X ボタンを押してもアプリが終了しない状況があり得る（ユーザー報告）。

## 調査結果 — 2系統の「閉じられない」経路が存在する

### 1. JS リスナー登録後は JS 以外で絶対に閉じられない（Tauri 2 の仕様）

tauri 2.11.6 `manager/window.rs` の `on_window_event`:

```rust
WindowEvent::CloseRequested { api } => {
  if window.has_js_listener(WINDOW_CLOSE_REQUESTED_EVENT) {
    api.prevent_close();          // JS リスナーが居る限り常にクローズ抑止
  }
  window.emit_to_window(WINDOW_CLOSE_REQUESTED_EVENT, &())?;
}
```

つまり `App.tsx` の `onCloseRequested` が登録された時点で、**閉じる判断は 100% JS に委譲**される。WebView2 レンダラーがハング（巨大スコアの同期レンダー、JS 無限ループ、WebView2 プロセス異常）すると emit は届くが JS が実行されず、`destroy()` が呼ばれないため **永久に閉じられない**。タスクマネージャーからの kill が必要。

### 2. 同期コマンドがメインスレッドを無期限ブロック

Tauri 2 では非 async コマンドはメインスレッドで実行される。以下が全部同期:

| コマンド | ブロック内容 |
|---|---|
| `export_run` | MuseScore PDF レンダーを try_wait ポーリング — タイムアウトなし、MuseScore がハングすれば**無期限** |
| `audio_probe` | ffprobe/ffmpeg `child.wait()` — 無期限 |
| `capture_stop` / `capture_cancel` | キャプチャスレッド `join()` — 無期限 |
| `capture_start` | SESSION ロック保持中に WASAPI/COM プローブ |
| `capture_audio_sessions` | ActivateAudioInterfaceAsync 最大10秒待機 |
| `capture_devices` | COM 列挙 |
| `read_audio_bytes` | 最大数百MB のファイル読み込み |
| `project_write` / `project_autosave_write` | 大きな JSON のディスク書き込み |
| `export_pick_dir` / `project_save_path` | blocking_pick_folder（ネイティブダイアログ） |
| 他 | detect_tools, probe_tool_path, recordings_*, sources_* 等 |

メインスレッドが塞がれるとイベントループが WM_CLOSE を処理できず、さらに JS 側フォールバックの `destroy()`/`exit_app` invoke もディスパッチできない → **X が完全に無反応**。

特に `export_run` は MuseScore プロセスの終了を待つポーリングでタイムアウトが存在しないため、子プロセスがハングした場合は**タスク kill 以外の脱出経路がない**。`export_cancel` も同期なので、export 中はキャンセル invoke すら処理されない（キャンセルボタンも死ぬ）。

## 対応方針

1. **ブロッキング系コマンドを全て `#[tauri::command(async)]` 化** — 関数本体はそのまま tokio ワーカー上で実行され、メインスレッドが解放される。invoke の意味論は変わらないのでフロント変更不要。
   - 例外: `engine_write` / `engine_close_stdin` は同期維持 — fire-and-forget の NDJSON 書き込みで、async 化すると複数 invoke のタスク並列スケジュールにより**プロトコル行順序が入れ替わり得る**。代わりに `engine_kill`/`kill_engine_on_exit` 側の ENGINE ロック保持を reap の前で解放し、書き込み側のロック待ちを実質ゼロにする。
   - `shell_info` / `exit_app` も同期維持（軽量・exit_app は即時性が本質）。
2. **Rust 側クローズ・ウォッチドッグ** — `on_window_event` で CloseRequested を検知したら監視スレッドを起動。JS ハンドラは冒頭で新コマンド `close_request_ack` を発射して生存を通知。10秒 ack が無ければ Rust 側から `window.destroy()` を要求（メインスレッド生存時は JS 不要で窓が死ぬ）、さらに5秒で脱出しなければ `std::process::exit(0)`。エンジンは #185 の Job Object (KILL_ON_JOB_CLOSE) で道連れになるため孤児化しない。
   - 未保存ガードの確認ダイアログが出ている状態では JS が即座に ack を返すので、ユーザーがダイアログで悩んでいても殺されない。
   - レンダラーが 10 秒無応答の時点でダイアログを出せない以上、強制終了が唯一の脱出。未保存データは dirty 中の自動保存スナップショット (#221) が復元を担保する。
3. 併せて: `engine_kill` / `kill_engine_on_exit` で reap 前に ENGINE ロックを解放（`engine_write` の待ち時間を ~3-4秒→µs）。

## 影響範囲

- バージョン ≤0.2.5 では #177 の ACL 不具合でクリーン状態でも X が効かない既知バグあり（0.2.6 で修正済み）。最新版でも上記1・2により状況次第で閉じられない。
- 0.2.8 では NSIS インストーラーがエンジン未同梱（別 issue で対応）。

