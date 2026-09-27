Bundled-tools staging directory (#10).

resolve_ffmpeg looks for tools/ffmpeg[.exe] under the resource roots;
tauri.bundled.json already maps "resources/tools/*" -> "tools/", so a
release build picks up whatever lands here automatically.

To ship a static ffmpeg (Windows):
  1. Place ffmpeg.exe next to this README.
  2. Build: npx tauri build --config src-tauri/tauri.bundled.json
  3. The diagnostics sheet's FFmpeg row should then show the bundled
     path (see docs/RELEASE.md section 6).

For the portable zip instead of the installer, drop a tools/ folder
beside horn-scribe.exe — the exe-dir root resolves it the same way.
