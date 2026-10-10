## 症状

v0.2.1 で録音（PC の音 / マイク）→ 解析を実行すると hornscribe-desktop.exe が即座にクラッシュする。WER から:

- 例外コード 0xC00000FD = STATUS_STACK_OVERFLOW
- faulting module は hornscribe-desktop.exe 自身（WebView 側ではなく Rust プロセス）
- タイミングは録音 WAV ファイルの書き込み完了直後

## 根本原因

audio_probe → sha256_file が let mut buf = [0u8; 1 << 20]; と 1 MiB をスタックに確保する（apps/desktop/src-tauri/src/audio.rs）。

リリース exe の PE SizeOfStackReserve は 0x100000（ちょうど 1 MiB）。Tauri の同期コマンドはこのスタック予約で動くスレッド上で実行されるため、バッファだけで予約を使い切り、既存フレーム + read 書き込みでガードページに接触して 0xC00000FD となる。

- バッファへは read が書き込んだ分だけページがコミットされるため、数 MB 級の実音源ではほぼ確実にクラッシュする一方、数百 KB 以下の小さな WAV では生存する → dev fixture やドッグフードの小音源では再現せず検出漏れした
- fad5be82 (#294, native audio probe 導入) で混入。v0.2.0 / v0.2.1 / v0.2.2 すべてに含まれる
- つまり公開済みリリースはすべて「ファイル取り込み・録音取り込みでクラッシュし得る」状態

## 修正方針

- sha256_file のバッファをヒープ（Vec）に移す。併せて「同期コマンド経路で大きなスタック配列を置かない」旨のコメントを残す
- 同種のスタック大容量確保を監査済み：audio.rs:178 が唯一の 64KiB 超スタック配列（他は vec! ヒープ確保済み）
- リグレッション防止として数 MB ファイルに対する sha256_file のユニットテストを追加

## 影響

録音→解析のみならず、数 MB 以上の音声ファイルの取り込み全般がクラッシュし得る。次のパッチリリースに必須。