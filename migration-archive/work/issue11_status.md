PR #50 で実装済みの部分:

- 書き込み状態の配置を `tools.rs::data_dir` に集約: `HORNSCRIBE_DATA_DIR` → exe 隣 `data/`(ポータブル印)→ OS app-data。録音・sources・source-refs・cache・autosave・logs がすべてこの配下に入る
- ポータブル zip で `data/` を同梱すれば %APPDATA% を一切触らない自己完結配置になる。RELEASE.md の構成手順を `engine/` + `tools/` + `data/` の3点に更新済み
- 同梱解決パス: `engine/hornscribe-engine.exe` と `tools/ffmpeg.exe` は exe 隣でも解決する(installer 不要)

残件(本 issue は継続):
- 実機でのポータブル zip 総合確認(解凍 → exe 直起動 → 採譜・録音・保存が同梱dir内で完結)はリリースビルドができる環境で実施
- 配布物の実サイズ計測を Release 公開時に記録
