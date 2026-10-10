## Summary
Closes the last open acceptance item of #230 — the peak-memory gate. A new `memory_gate` test module in `audio.rs` synthesizes a ~10-minute stereo WAV (~106 MB) and asserts `probe_wav` + `sha256_file` keep peak working-set growth under a 32 MiB streaming budget.

- `peak_working_set()` reads `PeakWorkingSetSize` via `GetProcessMemoryInfo` (kernel32 `GetCurrentProcess`); two new `windows` crate features (`Win32_System_ProcessStatus`, `Win32_System_Threading`) — same crate version, no new packages, lockfile untouched.
- The measurement runs in a child test process (`--exact --include-ignored`) so `PeakWorkingSetSize`, a process-wide high-water mark, cannot be inflated by sibling tests and mask a regression.
- Non-Windows returns 0 and the assert is a no-op; CI runs `cargo test --locked` on windows-latest where the gate is live.

## Test plan
- `rustfmt --emit stdout` parses clean (cargo build unavailable locally — no VC linker; CI `cargo test` is the verifier).
- `windows` 0.61.3 API signatures verified against vendored sources: `GetProcessMemoryInfo -> windows_core::Result<()>`, `PROCESS_MEMORY_COUNTERS.PeakWorkingSetSize: usize`, `GetCurrentProcess -> HANDLE`.

Part of #230 (all acceptance items now covered — propose closing).
