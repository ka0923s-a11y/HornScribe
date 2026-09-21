# UI-002 spike results — Python sidecar IPC and lifecycle (engine side)

> Status: Engine-side spike complete 2026-09-22 on Windows 11, Python
> 3.12.10. The Tauri shell half of UI-002 is a separate in-flight spike
> (UI-001); everything below is proven **without** the GUI by driving a
> real `python -m hornscribe.worker` subprocess over anonymous pipes —
> the same supervision contract the shell will implement in Rust.
>
> Implementation: `python/hornscribe/worker/{protocol,jobs,worker,__main__}.py`
> Harness: `tests/python/test_worker.py` (`WorkerHandle` = test-side shell)
> Contract: `protocol/PROTOCOL.md` (spike extensions marked `[UI-002]`)

## Proven in the engine (automated, 58 tests green)

| Issue acceptance criterion | Evidence | Result |
|---|---|---|
| handshake reports protocol/backend version/capabilities | `test_handshake_reports_version_engine_and_capabilities` — returns `protocolVersion`, `engineInfo{name,version,python,platform,pid}`, `capabilities{methods,jobKinds,cooperativeCancel,cancellationFallback,basicPitchAvailable}` | ✅ |
| request/response correlation works | `test_ping_echoes_and_correlates_ids` — ids echoed exactly; events interleave with responses without disturbing correlation | ✅ |
| progress streams without blocking UI | `test_demo_long_task_streams_progress_to_completion` + `test_requests_are_answered_while_job_runs` — `job.event` frames stream (`started`→`progress`→`completed`, monotonic `progress`); ping answered in <1 ms while a ~1.5 s job runs | ✅ |
| timeout is handled | Two layers proven: engine-side `deadlineMs` → terminal `failed` event `JOB_TIMEOUT` (`test_engine_side_job_deadline_times_out`); supervisor-side read timeout catches a wedged worker via `debug.hang` (`test_unresponsive_worker_is_caught_by_supervisor_timeout`) | ✅ |
| malformed message is contained safely | `test_malformed_json_is_contained` (5 cases) + `test_malformed_envelopes_are_contained` (6 cases): garbage JSON, non-objects, missing/wrong-typed `v`/`id`/`kind`/`method` all → structured `MALFORMED_MESSAGE` response (id recovered when possible, `id: null` otherwise); worker stays up | ✅ |
| stdout remains protocol-clean | `test_stdout_carries_only_protocol_frames_and_stderr_gets_logs` — every stdout line parses as a valid `v=1` envelope; all diagnostics verified on stderr | ✅ |
| stderr logs are captured separately | same test — `sidecar started/stopped` lifecycle logs captured on stderr | ✅ |
| worker crash does not terminate UI | `test_crash_is_detected_and_restart_restores_service` — `TerminateProcess` mid-job (Windows kill -9 equivalent); supervisor detects nonzero exit + stdout EOF; in-flight job never emits a terminal event → supervisor marks it failed (ADR-0002: never silently resubmitted) | ✅ |
| worker restart works without restarting UI | same test — a second worker is spawned, handshakes identically, and completes a fresh job; engine is stateless so nothing is lost (project state lives in the shell-side FND-001 store) | ✅ |
| incompatible major protocol version fails clearly | `test_envelope_version_mismatch_fails_clearly` (per-frame `v`) + `test_handshake_rejects_incompatible_version_and_exits` (handshake `protocolVersion: 99` → `PROTOCOL_VERSION_MISMATCH` with `details.supported`, then worker exits 0 — refusal, not crash) | ✅ |
| automated parser/lifecycle tests exist | `tests/python/test_worker.py` (32 subprocess lifecycle tests) + `tests/python/test_worker_protocol.py` (26 parser/builder unit tests) | ✅ |
| graceful shutdown | `test_engine_shutdown_is_graceful` (exit 0), `test_stdin_eof_is_a_clean_shutdown` (EOF → exit 0), `test_shutdown_cancels_active_job` (in-flight job cooperatively cancelled on the way out) | ✅ |
| cooperative cancellation | `test_job_cancel_is_cooperative_and_prompt` — measured **15 ms** from `job.cancel` request to terminal `cancelled` event (sub-step-boundary, steps = 20 ms) | ✅ |
| kill fallback documented + demonstrated | `test_crash_is_detected_and_restart_restores_service` demonstrates terminate→detect→restart; `capabilities.cancellationFallback = "terminate+restart"` advertises it in the handshake | ✅ |

Measured on this machine: first-frame (handshake) latency ≈ 200 ms —
dominated by interpreter startup after spawn; steady-state ping RTT
< 1 ms; cooperative cancel latency 15 ms (≪ one 20 ms step); graceful
shutdown < 100 ms.

## Cancellation model — honest statement

`demoLongTask` is chunked work with a cancel checkpoint **between
steps**, which is why 15 ms cooperative cancel is real for it. Basic
Pitch ONNX inference is a **single blocking C++ call** (see
`docs/ENGINE_RUNTIME_MATRIX.md`, "Cancellation") — a cooperative flag
cannot interrupt it mid-call. The envelope and `job.cancel` semantics
stay identical either way; per ADR-0002 the MVP fallback for
non-interruptible work is **worker terminate/restart**, which this spike
exercises end-to-end (kill mid-job → crash detected → restart → fresh
job completes). Measuring cancel latency against *real* Basic Pitch
inference remains on the real-backend gate below.

## Protocol additions discovered during the spike

Draft `protocol/PROTOCOL.md` was extended (all marked `[UI-002]`):

- `id: null` **error responses** for frames too broken to recover an id
- inbound `response`/`event` frames are logged and dropped, never
  answered (no reply loops)
- handshake version mismatch → `PROTOCOL_VERSION_MISMATCH` **then worker
  exits 0** — refusal is explicit *and* final
- `job.event` terminal phases: `completed` | `cancelled` | `failed`
  (failure detail in `payload.error`, envelope `error` stays null —
  the frame is well-formed even when the job is not)
- `demoLongTask` params: `steps`, `stepDurationMs`, `deadlineMs`,
  `failAtStep` (test hook)
- `JOB_ALREADY_RUNNING` — spike workers run one job at a time
- `debug.hang` — spike-only supervisor test hook, not a stable API

## Still gated on the UI-001 Tauri shell

| Issue acceptance criterion | Why gated |
|---|---|
| worker launches in dev **and packaged app** | needs the Tauri sidecar spawn/bundle plumbing |
| real Basic Pitch smoke job through the shell | engine `basicPitchAvailable` capability is wired, but packaging the FND-002 `--no-deps` ONNX build into the app is shell work |
| cancellation during **real** inference measured | needs the packaged Basic Pitch path end-to-end; cooperative-cancel-inside-inference is expected to fail (blocking call) → terminate/restart fallback is already proven here |
| project state survives worker failure in the app | engine side proven stateless; the FND-001 project store lives shell-side and must be exercised through the real app |

## Reproduce

```bat
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m pytest tests/python/test_worker.py tests/python/test_worker_protocol.py -q
.venv\Scripts\python -m hornscribe.worker   # speaks NDJSON on stdin/stdout
```
