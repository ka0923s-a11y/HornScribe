## 根本原因の特定（検証済み）

WER のクラッシュ記録: hornscribe-desktop.exe 0.2.1.0 / 例外 0xC00000FD (STATUS_STACK_OVERFLOW) / 録音 WAV 書き込み直後。

- audio_probe → sha256_file が 1 MiB をスタック確保（let mut buf = [0u8; 1 << 20]）
- リリース exe の PE SizeOfStackReserve = 0x100000（ちょうど 1 MiB）。Tauri 同期コマンド実行スレッドのスタック予約そのもの
- バッファが予約を使い切るため、最初の read がバッファを埋めるだけの実音源（数 MB〜）で確定的にガードページへ接触 → クラッシュ。小音源は read が書いた分しかコミットしないので生存 → 開発時に検出漏れした理由

## スタンドアロン検証バイナリで生死を実証

sha256_file を verbatim コピーした新旧実装を stack_size(1<<20) のスレッドで 8MB ファイルに対し実行:

- 旧版（スタック配列）: thread has overflowed its stack / exit -1073741571 = 0xC00000FD を完全再現
- 新版（vec! ヒープ）: OK / exit 0

## 修正（PR #150, a58c182c）

- sha256_file のバッファをヒープ確保に変更 + 経路上で大きなスタック配列を置かない旨のコメント
- リグレッションテスト: sha256_stack_gate_child（子プロセス・1 MiB スタックスレッドで sha256_file 実行）+ sha256_file_fits_in_one_mib_stack。旧実装なら子プロセスが abort して失敗する決定的ゲート
- 注: ローカル環境では crate テストバイナリ自体が既知の環境問題（0xc0000139）で起動しないため cargo check --tests まで検証し、実機確認はスタンドアロン実証で代替

v0.2.3 としてリリースします。