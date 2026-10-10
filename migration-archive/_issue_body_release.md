## 背景

docs/RELEASING.md は「GitHub → Actions → Release → Run workflow」起点の
リリース手順を記述しているが、このリポジトリには .github/workflows/
自体が存在しない(ワークフローファイル未同梱)。さらに運用制約として
GitHub Actions の使用は禁止のため、記載どおりに実行できない
「壊れたリリース手順」が正規ドキュメントとして残っている。

## 問題

- 参照している release.yml が存在しない → 手順通りに進まない
- Actions 禁止の制約と正面から矛盾
- 「ソフトのリリースが正常に行える」状態でない — ローカル完結の
  正式経路が未定義

## あるべき姿

ローカル一発で回るリリーススクリプト(例: scripts/release.py):

1. package.json / tauri.conf.json の version 一致を検証
2. フロント・Rust・Python エンジンのテスト実行
3. scripts/build_engine.py で frozen エンジン生成(~130MB)
4. npx tauri build --config src-tauri/tauri.bundled.json で NSIS インストーラ
5. scripts/package_portable.py でポータブル zip
6. gh release create でアセット公開(バージョンタグ含む) — Actions 不要

既存ピース(build_engine/package_portable/smoke_engine)のオーケストレーション +
RELEASING.md の更新で完結できる。gh CLI による Release 作成は Actions
ではなくローカル操作なので制約に抵触しない。

## 検証ポイント

- 冪等性(同名 Release 既存時の挙動)
- version 不一致時の早期失敗
- 成果物サイズ健全性(エンジン同梱 ~50MB+ チェック)
- ポータブル zip 内に engine/hornscribe-engine.exe