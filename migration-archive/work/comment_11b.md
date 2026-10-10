進捗 (2026-09-28): Rust 側のコンパイル検証経路を確保しました。

**管理者権限なしで使える代替検証ルート(開発用)**
- `rustup target add x86_64-pc-windows-gnu` + 既存の `stable-x86_64-pc-windows-gnu` ツールチェーン
- llvm-mingw (winget user scope, `MartinStorsjo.LLVM-MinGW.UCRT`) が PATH にあるため `x86_64-w64-mingw32-gcc` がリンカとして解決する
- RUSTFLAGS でライブラリ探索を補うと `cargo check` が完走する:
  ```
  $env:RUSTFLAGS='-L <llvm-mingw>/x86_64-w64-mingw32/lib -L <llvm-mingw>/lib/clang/22/lib/windows -L <rustup-gnu-self-contained>'
  cargo +stable-x86_64-pc-windows-gnu check   # Finished dev profile, 2m37s
  ```
  (順序重要: llvm-mingw(UCRT)を先、rust self-contained(libgcc/libgcc_eh)を後)

**残ブロッカー(変わらず)**
- 正式リリースビルド(msvcターゲット, `npx tauri build`)は VC++ ワークロード必須 — 非管理者セッションでは追加不可。
- gnu ビルドのテスト exe は起動時 0xc0000139 (STATUS_ENTRYPOINT_NOT_FOUND) で落ちる — webview 系 DLL の問題と推定。gnu ルートは型/コンパイル検証用途に限定。

コード側の残作業はなし。リリース検証は引き続き VCTools 導入後の実機で行う。
