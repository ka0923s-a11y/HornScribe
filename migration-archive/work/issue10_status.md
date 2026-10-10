PR #50 で実装済みの部分:

- ffmpeg 解決順を一本化(`tools.rs::resolve_ffmpeg`): 設定オーバーライド → `HORNSCRIBE_FFMPEG` → 同梱 `tools/ffmpeg.exe` → PATH。`audio_probe`(取り込み)・`detect_tools`(診断)・FLAC 正規化がすべて同じ順序で解決するようになった
- 設定 → ツール の FFmpeg パスが取り込み側にも効くようになった(従来は PATH 限定で設定が無視されていた不整合を修正)
- 同梱 `tools/` はエンジン子プロセスの PATH にも注入 → Python 側 audioread/demucs が同じバイナリを解決
- worker handshake が `demucsAvailable` / `ffmpegAvailable` を返し、診断情報に「demucs(ボーカル分離)」行を追加(#10 の「検出結果を診断画面で明示」)
- PACKAGING.md に同梱配置(`resources/tools/` → `tools/` または exe 隣 `tools/`、tauri.bundled.json への追記方法)とサイズ見積もりを記録

残件(本 issue は継続):
- ffmpeg static binary を実際にリリース成果物へ同梱するかの最終判断 + ライセンス確認(配置すれば動く土台は完成)
- demucs の frozen engine 同梱は +1〜2GB — engine-vocal extra 任意のまま。軽量 ONNX 分離モデルへの移行は別途検討価値あり
