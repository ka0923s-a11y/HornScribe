## Summary
- Fixes #235: capture recordings no longer buffer f32 samples in RAM. The WASAPI worker encodes each packet to PCM16 and streams it into recording-<pid>-<ms>.part under recordings/, so memory stays bounded at one packet regardless of session length.
- The temp WAV is written with a placeholder header that gets patched with the real data length on finalize; capture_stop renames it to the user-facing file name (with a copy fallback for cross-volume renames), cancel/error paths delete it, and capture_start prunes orphaned .part files left by crashed sessions.
- Correctness fixes inside the new path: s.frames counts only frames actually written so the patched WAV data_len always matches the file contents (a limit-reached recording previously would have declared more data than it holds), and the silence/peak pass iterates real written frames so nonstandard block_align or unknown formats cannot panic the worker. nChannels is clamped to >=1.

## Notes
- Rust not compile-verified locally: this environment has no working VC linker (build scripts fail). Verified via rustfmt parse plus manual review; behavior on-device should be smoke-tested on a machine with a working toolchain before release.
- No frontend change needed: Tauri injects AppHandle for the new app parameters on capture_start/capture_stop.

