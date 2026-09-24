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
| `tauriPort.ts` | `TauriSidecarPort` — production port: the Rust `engine` module spawns `python -m hornscribe.worker` and relays lines over a `Channel` (ENG-002). |
| `devBridgePort.ts` | `DevBridgeSidecarPort` — browser-dev port (#86): spawns the real worker through the `devEngineBridge` Vite middleware (scripts/devEngineBridge.mjs) over localhost HTTP+SSE; falls back to the mock when the bridge is absent. |
| `jobView.ts` | Pure reducer: `job.event` → stage list + progress view (§5). |
| `session.ts` | `TranscriptionSession` — app-facing engine/job state machine the shell subscribes to. |
| `review.ts` | TS mirror of `domain/review.py` reason codes + `result.reviewIssues` extraction. |

## Transport (ENG-002 — wired)

`SidecarClient` is transport-agnostic; the port is the only piece that
knows how a worker is spawned. `createDefaultSidecarPort()` returns:

- `TauriSidecarPort` inside the Tauri webview — `engine_spawn` (an
  app-defined `#[tauri::command]`, not capability-gated) launches
  `python -m hornscribe.worker` in `src-tauri/src/engine.rs` and relays
  stdout/stderr/exit over a `Channel`. The interpreter resolves via
  `HORNSCRIBE_PYTHON` → repo-local venvs → PATH; the module path via
  `HORNSCRIBE_PYTHONPATH` → the repo's `python/` directory.
- `DevBridgeSidecarPort` outside the Tauri webview: it probes
  `/__engine/health` and drives the real worker when the dev bridge is
  up, otherwise it delegates to `MockSidecarPort` so `vite dev` without
  Python still exercises the UX.
- `UnsupportedSidecarPort` remains the explicit-failure placeholder for
  runtimes with no spawn bridge.

No plugin capability was widened: `capabilities/default.json` still
grants only `core:*` defaults, and the spawned program is fixed
Rust-side (`hornscribe.worker`), so the bridge cannot be turned into a
general process launcher.

### Remaining production gap

The spawn bridge assumes a Python interpreter with the `engine` extras
is reachable (dev venv or PATH). Bundling a frozen engine runtime into
the packaged installer is a tracked follow-up — until then the app is
honest: `ENGINE_UNAVAILABLE` surfaces the engine-not-responding
recovery path (エンジンを再起動 + 診断情報), never a silent mock.

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
