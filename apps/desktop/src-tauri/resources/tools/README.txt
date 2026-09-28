Bundled-tools staging directory (#10).

resolve_ffmpeg looks for tools/ffmpeg[.exe] under the resource roots;
tauri.bundled.json already maps "resources/tools/*" -> "tools/", so a
release build picks up whatever lands here automatically. The engine
child also gets this dir prepended to PATH, so engine-side tools
(audioread, the demucs resolver) see the same binaries.

To ship a static ffmpeg (Windows):
  1. Place ffmpeg.exe (and ffprobe.exe for `doctor`/diagnostics) next
     to this README. A gyan.dev *essentials* build is the recommended
     size/function trade-off (~105 MB per binary vs ~227 MB for the
     full build); include its LICENSE/README files — GPL builds
     require notice. Current staging: essentials 9.0.2.
  2. Build: npx tauri build --config src-tauri/tauri.bundled.json
  3. The diagnostics sheet's FFmpeg row should then show the bundled
     path (see docs/RELEASE.md section 6).

demucs can ride the same directory as a frozen demucs.exe — the
engine's resolver finds bundled tools via PATH before probing other
interpreters (see docs/PACKAGING.md, demucs section).

For the portable zip instead of the installer, drop a tools/ folder
beside horn-scribe.exe — the exe-dir root resolves it the same way.

*.exe files in this directory are gitignored — binaries are staging
artifacts, never committed payloads.
