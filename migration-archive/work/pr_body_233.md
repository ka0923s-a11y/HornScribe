## Summary
- Fixes #233: the terminate+restart fallback existed end-to-end (SidecarPort.kill -> engine_kill -> Child::kill) but the product flow never reached it. Cancelling during blocking Basic Pitch/pYIN inference left the UI stuck in 'cancelling…' until inference returned, and a wedged worker kept the Rust ENGINE slot so the next spawn could hit ENGINE_ALREADY_RUNNING.
- SidecarClient.shutdown() now falls back to port.kill() when the graceful window expires (plus a short exit wait so a respawn cannot outrun the dying process); new terminate() provides the immediate kill for the cancel-escalation path.
- TranscriptionSession.cancelTranscription() waits cancelGraceMs (default 4 s, injectable) for the terminal event after the job.cancel ack; on expiry it marks the job 'cancelled' BEFORE the kill (so the exit path cannot label it a crash), terminates the worker, and respawns a fresh engine. Audio/prior score/project state are untouched.
- restartEngine() awaits the old shutdown, and job/state callbacks are guarded to the current client so a replaced worker's late frames cannot downgrade the fresh engine.
- MockSidecarPort gains simulateBlockingInference() (dispatch still answers job.cancel, but the job thread never reaches a checkpoint) and closeStdin() is a no-op while wedged — matching the real worker's debug.hang semantics.

## Tests
- session.test.ts: cancel escalation ends 'cancelled' with a fresh ready engine; cooperative cancel within grace never kills; restartEngine kills a wedged worker.
- client.test.ts: shutdown() kill fallback; terminate() rejects pending requests.
- Full suite: 521 vitest passed, tsc + eslint clean.

## Notes
- Acceptance criterion 'packaged Tauri + real backend measured test' is not covered here — this env has no working VC linker for the Rust build. The frontend contract is fully exercised against the mock, which mirrors worker.py semantics; a real-device smoke test should confirm timing before release.

