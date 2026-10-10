PR #140 で scripts/release.py を実装・マージし、実際に v0.2.0 を本番
リリースして経路の正常動作を実機で証明しました。

実施したリリース: https://github.com/ka0923s-a11y/HornScribe/releases/tag/v0.2.0

パイプライン実績(全自動・ローカル完結):

- preflight: version 一致検証 / gh CLI / Release 重複 / タグ衝突検査
- テスト: tsc + eslint + vitest 891 + cargo check + pytest 1056 全緑
- frozen engine: PyInstaller で再ビルド + smoke_engine 疎通
- NSIS: tauri build --config tauri.bundled.json で 233.4MB
  (エンジン同梱済 — 従来の 6.17MB 不良品と区別を検証ゲートが担保)
- ポータブル: package_portable.py で 255.1MB(engine 再 smoke 後 zip)
- 検証: 両アセット ≥50MB + zip 内 engine/hornscribe-engine.exe 確認
- 公開: 注釈付きタグ v0.2.0 push → gh release create --prerelease

併せて修正した関連問題:

- Windows の subprocess は .cmd shim を解決しないため
  npm/npx/gh/cargo を shutil.which で実パス解決
- RELEASE_NOTES.md の portable exe 名を実体に修正(HornScribe.exe)
- RELEASING.md を release.py ベースに全面書き直し、
  RELEASE.md は手動内訳として相互リンク
