# src/sidecar — engine sidecar client (UI-040)

TypeScript client for the HornScribe engine worker: NDJSON over
stdin/stdout per [`protocol/PROTOCOL.md`](../../../protocol/PROTOCOL.md),
implemented engine-side by `python/hornscribe/worker/` (UI-002 spike).

## Layers

| File | Role |
|---|---|
| `protocol.ts` | Envelope types, error codes, frame encode/parse — mirror of `worker/protocol.py`. |
| `port.ts` | `SidecarPort` — process-lifecycle seam (spawn/stdin/stdout/stderr/exit). No protocol logic. |
| `client.ts` | `SidecarClient` — handshake, request/response correlation, `job.event` demux, per-request timeouts, in-flight-job watchdog, crash detection. |
| `mockPort.ts` | `MockSidecarPort` — in-process emulation of `python -m hornscribe.worker` (same validation, same job semantics, plus crash/hang hooks). |
| `jobView.ts` | Pure reducer: `job.event` → stage list + progress view (§5). |
| `session.ts` | `TranscriptionSession` — app-facing engine/job state machine the shell subscribes to. |
| `review.ts` | TS mirror of `domain/review.py` reason codes + `result.reviewIssues` extraction. |

## Transport gate — read before wiring the packaged app

`SidecarClient` is transport-agnostic; the port is the only piece that
knows how a worker is spawned. Today there is **no real spawn path**:

- `src-tauri/capabilities/default.json` grants only `core:*` defaults —
  deliberately no `shell:`/`process:` plugin permissions.
- `src-tauri/Cargo.toml` registers no plugins at all.

`createDefaultSidecarPort()` therefore returns:

- `MockSidecarPort` outside the Tauri webview (plain `vite dev` / vitest);
- `UnsupportedSidecarPort` inside Tauri — `start()` rejects with
  `ENGINE_UNAVAILABLE`, which the session surfaces as the honest
  engine-not-responding failure (エンジンを再起動 + 診断情報), never a
  silent mock in the product shell.

### Production port contract (when the spawn bridge lands)

A `TauriSidecarPort` implements `SidecarPort` by:

1. spawning `python -m hornscribe.worker` (dev) or the bundled engine
   executable (packaged) — either through `tauri-plugin-shell`'s
   `Command.spawn()` + stdout/stderr/terminate events (requires adding the
   plugin + `shell:allow-spawn` capability — a deliberate, reviewed
   capability change), or a custom `#[tauri::command]` + `Channel`
   supervisor in Rust (app-defined commands are not capability-gated);
2. forwarding each stdout line → `onLine`, stderr → `onStderr`, exit →
   `onExit(code)`;
3. `writeLine` → stdin write with `\n`; `closeStdin` → stdin EOF
   (implicit graceful `engine.shutdown` per worker.py);
4. `kill` → terminate — the documented fallback for non-interruptible
   jobs (ENGINE_RUNTIME_MATRIX "Cancellation").

No client/session code changes should be needed when that port lands.

## Protocol notes (UI-040 additions — documented in PROTOCOL.md)

- `job.event` may carry `stage` (one of `TRANSCRIPTION_STAGE_IDS`) — the
  only honest source for the §5 stage list. Jobs without it (e.g.
  `demoLongTask`) show all stages pending; the UI never guesses.
- `job.event` `completed` may carry `result.reviewIssues` —
  `ReviewIssue.to_dict()` payloads; UI-040 surfaces only the count,
  UI-030's score adapter consumes the full result.
- Shell-side supervision codes `WORKER_CRASHED` / `WORKER_UNRESPONSIVE` /
  `REQUEST_TIMEOUT` never appear on the wire — they mark what the client
  itself detected, mirroring the UI-002 harness's supervisor policy
  (ADR-0002: an in-flight job of a dead worker is marked failed, never
  silently resubmitted).

## Dev routes

- `#/dev/audio-ready` — shell starts in AUDIO_READY (bypasses UI-020's
  file-open wiring for review purposes).
- `#/dev/transcribing` — additionally auto-invokes `score.transcribe`.
- Both are `import.meta.env.DEV`-gated and absent from production builds.
