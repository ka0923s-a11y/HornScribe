## 概要

#177 調査中に発見した耐久性の問題。エンジン系コマンドが Tauri の同期コマンドとして実装されており、ブロッキング I/O がメインスレッド(UI)を凍らせ得る構造になっている。

## 問題

1. `engine_write` が `ENGINE` ミューテックスを保持したまま stdin へ `write_all` + `flush` する。worker が読み取らない間にパイプバッファが満杯になると書き込みがブロックされ、**同期コマンドはメインスレッドで実行されるため UI 全体(X ボタン含む)が凍結**する
2. その状態で終了すると `RunEvent::Exit` の `kill_engine_on_exit` が同じミューテックスを待ち続け、プロセスがゾンビ化し得る
3. `engine_spawn` / `engine_kill` も同期コマンドで、spawn/`wait()` の間 UI を止める(現状は短時間だが構造的に同じ問題)

現状は worker のメインループがジョブ中も `readline()` を回すため実害は稀だが、大きな NDJSON 行(score.edit の全ドキュメント等)や worker 停止中の書き込みで発生し得る。

## 改善案

- `engine_write`: stdin を writer スレッドに移し、`mpsc::channel` 送信のみにする(送信はブロックしない・順序も保持)。`engine_close_stdin` は sender を drop して writer 終了 → stdin EOF という既存契約を維持
- `kill_engine_on_exit`: ロックを `try_lock` + リトライの上限付きにし、取得できなくても PID ベースで強制終了できるようにする
- `engine_spawn`: `tauri::async_runtime::spawn_blocking` 経由にして spawn/probe 中の UI 停止を解消

## 優先度

中 — #177 の「閉じれない」と同系統のユーザー影響(UI フリーズ/ゾンビプロセス)になり得るが、発生条件が限定的。
