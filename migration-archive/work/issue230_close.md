すべての受け入れ条件を実装しました。

- path-backed sourceはWebViewへ全bytesをIPC転送しない → `probeAudio` port + native `audio_probe` (PR #294)
- hashをstreaming/native側で計算 → `sha256_file` streaming SHA-256 (PR #294)
- peaksはcompact arrayとして受け取る → 600-bucket `peaks` をRust側で計算 (PR #294)
- advertised WAV/MP3/FLAC/M4A/OGGをFFmpeg fallback含めて実際に開ける → `probe_ffmpeg` decode fallback + FLAC→WAV cache + `media://` streaming (PR #294)
- 3分/10分音源でpeak memoryを計測しgate化 → `audio::memory_gate` テスト: ~10分/106MB WAV合成 + `PeakWorkingSetSize` 計測、32MiB予算を子プロセスでCIゲート化 (PR #297)
- source fileは引き続きread-only → probe/hashは読み取りのみ、`media://` も読み取り専用scheme (PR #294)
- browser-dev fallbackは別経路として維持可能 → probe null時はbyte pathへフォールバック (PR #294)

残課題なしのためクローズします。
