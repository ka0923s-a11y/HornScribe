## 概要

v0.2.0 のインストーラー版・ポータブル版ともに起動直後にシステムエラー「WebView2Loader.dll が見つからないため、コードの実行を続行できません」でクラッシュする。

## 原因

- gnu toolchain (stable-x86_64-pc-windows-gnu) でビルドした場合、WebView2Loader.dll は動的リンク必須（MSVC の WebView2LoaderStatic.lib による静的リンクは使えない）。
- target/release/WebView2Loader.dll は生成されているが、tauri.bundled.json の bundle.resources に含まれていないため NSIS インストーラに同梱されない。
- scripts/package_portable.py も DLL をステージングしないためポータブル zip にも入らない。

## 修正方針

1. release.py: WebView2Loader.dll が存在する時だけ bundle.resources に注入した一時 config を生成して tauri build --config に渡す（MSVC 環境では DLL が生成されないため無条件追加だとビルドが壊れる）。
2. package_portable.py: DLL が存在する時だけ zip ルート（exe 隣）にコピー + サイズレポート/README に追加。
3. release.py verify: DLL が生成されたビルドではポータブル zip に WebView2Loader.dll が含まれることを必須 assert。

## 対応

- v0.2.1 として修正版をリリース。v0.2.0 は起動不能のため注意喚起。
