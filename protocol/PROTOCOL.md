# HornScribe IPC protocol draft

> Status: Draft contract for the UI-002 spike; extensions found during
> the spike are marked **[UI-002]** below.
> Transport: NDJSON over stdin/stdout between the Tauri shell and the Python
> engine sidecar. stderr is reserved for human-readable logs.

## Envelope

Every message on the wire is a single JSON object:

```json
{
  "v": 1,
  "id": "req-000001",
  "kind": "request | response | event",
  "method": "engine.ping",
  "payload": {},
  "error": null
}
```

Rules:

- `v` is the protocol version; mismatched versions fail the handshake.
- `id` correlates requests/responses; events use `id: null`.
- `kind=request` requires a `method`; `kind=response` echoes the request `id`
  and carries either `payload` or `error`, never both.
- `kind=event` carries progress/cancellation notifications.
- `error` is `{code, message, details?}`; codes are UPPER_SNAKE.
- Unknown additive fields are ignored safely (ADR-0002).
- **[UI-002]** `id` must be a non-empty string on requests and responses;
  on events `id` must be exactly `null`.
- **[UI-002]** If an inbound frame is too malformed to recover an `id`
  (unparseable JSON, non-object, missing id), the worker still replies
  with a `kind=response` carrying `id: null` and
  `error.code = "MALFORMED_MESSAGE"`. This is the only case where a
  response may carry a null id.
- **[UI-002]** The worker only ever receives `kind=request`. Inbound
  `response`/`event` frames are logged to stderr and dropped — never
  answered — so a reply loop is impossible.

## Initial methods (UI-002 spike)

| Method                 | Payload                        | Notes                          |
|------------------------|--------------------------------|--------------------------------|
| `engine.handshake`     | `{protocolVersion, engineInfo}`| first message after spawn      |
| `engine.ping`          | `{echo}`                       | liveness + latency             |
| `engine.shutdown`      | `{}`                           | graceful exit request          |
| `job.start`            | `{jobKind, params}`            | returns `{jobId}`              |
| `job.cancel`           | `{jobId}`                      | cooperative cancellation       |
| `job.event` (event)    | `{jobId, phase, progress}`     | progress events, `id: null`    |

Cancellation semantics are validated against real inference in M3; the
envelope stays the same regardless of cooperative vs. kill-based cancel.

## Method details [UI-002]

### `engine.handshake`

Request payload: `{protocolVersion: int, clientInfo?: any}`.
Response payload:

```json
{
  "protocolVersion": 1,
  "engineInfo": {"name", "version", "python", "platform", "pid"},
  "capabilities": {
    "methods": [...],
    "jobKinds": ["demoLongTask"],
    "maxConcurrentJobs": 1,
    "cooperativeCancel": true,
    "cancellationFallback": "terminate+restart",
    "progressEvents": true,
    "basicPitchAvailable": false
  }
}
```

If the requested `protocolVersion` is unsupported the worker replies
`PROTOCOL_VERSION_MISMATCH` (with `details.supported`) **and then exits
0** — a worker must not serve a peer it cannot talk to. A `v` mismatch
on any *other* frame is answered with `PROTOCOL_VERSION_MISMATCH` and
the worker stays up; supervision (kill/restart) is the shell's job.

### `engine.ping`

Echoes `payload.echo` back verbatim, plus `workerPid`/`uptimeMs`.

### `engine.shutdown`

Replies `{ok: true, activeJob}` and then exits 0. Any in-flight job is
cooperatively cancelled first (bounded join). stdin EOF is an implicit
`engine.shutdown`.

### `job.start`

`{jobKind: "demoLongTask", params: {steps?, stepDurationMs?, deadlineMs?, failAtStep?}}`
→ `{jobId, jobKind, state: "accepted"}`. One job in flight max; a second
`job.start` fails `JOB_ALREADY_RUNNING`. `deadlineMs` is an engine-side
timeout (terminal `failed` event, `JOB_TIMEOUT`). `failAtStep` is a
spike test hook (`JOB_FAILED`).

### `job.cancel`

`{jobId}` → `{jobId, cancellation: "requested"}`; `JOB_NOT_FOUND` when
no such active job. Cooperative: the job checks the flag **between
steps**, so latency ≤ one step duration. Blocking single-call work
(Basic Pitch ONNX inference) cannot honor it mid-call — the documented
MVP fallback is worker terminate/restart (ENGINE_RUNTIME_MATRIX.md).

### `job.event` (event, `id: null`)

`{jobId, jobKind, phase, progress, step?, totalSteps?, ...}`.
Phases: `started` → `progress`* → exactly one terminal phase:
`completed` | `cancelled` | `failed`. `failed` events carry
`payload.error = {code, message}` (envelope `error` stays `null` — the
frame itself is well-formed; the *job* failed).

### `debug.hang` [UI-002 — spike test hook, NOT a stable API]

`{seconds}` wedges the dispatch loop so a supervisor can exercise its
own read-timeout/kill path. Subject to removal without notice.

## Error codes [UI-002]

`PROTOCOL_VERSION_MISMATCH`, `MALFORMED_MESSAGE`, `UNKNOWN_METHOD`,
`INVALID_PARAMS`, `JOB_NOT_FOUND`, `JOB_ALREADY_RUNNING`,
`UNKNOWN_JOB_KIND`, `JOB_TIMEOUT`, `JOB_FAILED`, `INTERNAL_ERROR`,
`ENGINE_DEPENDENCY_MISSING` **[ENG-002]**, `NO_PITCHED_CONTENT`
**[ENG-002]**.

## Shell-side extensions [UI-040]

Additive fields and shell-side supervision codes introduced by the
desktop client (`apps/desktop/src/sidecar/`). Wire format is unchanged —
all additions are optional payload fields or codes that never leave the
shell.

### `job.event` `stage` field

Jobs that can honestly name their pipeline position emit
`payload.stage` — one of the GUI_UX_SPEC §5 stage ids
(`preparing_audio`, `transcribing`, `cleaning`, `analyzing_rhythm`,
`quantizing`, `building_score`, `rendering`, which are also the
`transcription.stages.*` keys in `protocol/copy/ja-JP.json`). Stage-less
jobs (e.g. `demoLongTask`) simply omit it; the UI must not infer a stage
from `progress` or elapsed time — an omitted stage is an honest
"unknown".

### `transcription` job kind

The real transcription job kind (`job.start {jobKind: "transcription"}`)
is implemented by ENG-002 (`python/hornscribe/transcription/`);
`SUPPORTED_JOB_KINDS` is `("transcription", "demoLongTask")` — the demo
kind stays for protocol/regression tests. The shell picks
`transcription` when `capabilities.jobKinds` advertises it and falls
back to `demoLongTask` otherwise (the documented UI-002→UI-040 bridge,
still exercised by `MockSidecarPort`, which emulates `transcription`
with the demoLongTask step engine plus `stage` fields and the result
payload below).

#### `job.start` params (`transcription`) [ENG-002]

`params` is an object; all fields are optional except `audioPath`:

| key                  | type    | notes                                        |
|----------------------|---------|----------------------------------------------|
| `audioPath`          | string  | required — absolute path the engine reads    |
| `displayName`        | string  | the user's file name for the score title — `audioPath` may be a staged temp path (#305) |
| `tempoBpm`           | number  | manual tempo (primary-beat BPM); omit = auto |
| `meter`              | string  | `"auto"` (accent-estimated) or `4/4,3/4,2/4,5/4,6/8,7/8,9/8,12/8` |
| `minDuration`        | string  | `"8"`/`"16"`/`"32"` — finest notated value    |
| `triplets`           | string  | `"auto"`/`"allow"`/`"none"`                   |
| `simplicity`         | string  | `"standard"`/`"simple"`/`"detailed"`          |
| `range`              | string  | `"all"`/`"selection"`                         |
| `selectionStartSec`  | number  | required with `range:"selection"`            |
| `selectionEndSec`    | number  | required with `range:"selection"` (> start)  |
| `deadlineMs`         | number  | wall-clock cap (same as demoLongTask)        |
| `texture`            | string  | `"auto"`/`"mono"`/`"melody"`/`"voices"`/`"chords"` — source texture hint (#85, #155) |
| `backend`            | string  | `"auto"`/`"basicPitch"`/`"pyin"` — engine selector; auto resolves pYIN for `texture:"mono"`, Basic Pitch otherwise (#175, #189) |
| `vocalIsolation`     | bool    | opt-in vocal isolation — center extraction, or demucs when the `engine-vocal` extra is installed (#187, #302) |

#### `completed` → `result` (`transcription`) [ENG-002]

`result` carries the score handoff:

- `scoreRevision` — `rev-*` content-derived score revision id;
- `scoreDocument` — the canonical `ScoreDocument.to_dict()`;
- `reviewIssues` — `ReviewIssue.to_dict()` payloads (see below);
- `musicXmlConcert` / `musicXmlHornF` — MusicXML 4.0 bodies for the
  concert-pitch and written-F管 presentations (identical `hs-sn-*` ids);
- `meta` — backend/version, duration, tempo (auto flag), meter,
  meter estimate (`meter`, `meterEstimated`, `meterConfidence` —
  accent-based auto estimation; weak evidence falls back to 4/4 and
  emits a `meter_conflict` review issue), key estimate
  (fifths/mode/confidence), note count, pickup beats, alignment shift,
  review reasons, cleaning stats (incl. `octaveCorrected`), echoed
  settings.

#### Error codes added by ENG-002

- `ENGINE_DEPENDENCY_MISSING` — the worker is up but a required engine
  package (basic_pitch, librosa) is not importable. `details.package`
  names the missing module. Retrying cannot help until the environment
  is fixed.
- `NO_PITCHED_CONTENT` — the pipeline ran cleanly but found no pitched
  notes (silent/noise-only audio, or an empty selection). A
  content-level outcome, not a crash.

### `job.event` `completed` → `result.reviewIssues`

A completed transcription carries `payload.result`, an object that may
include `reviewIssues`: an array of `ReviewIssue.to_dict()` payloads
(`python/hornscribe/domain/review.py`) with `reason` values mapping onto
`review.reasons.*` in the copy deck (`other` fallback for unknown
codes). The shell surfaces only the count in UI-040; UI-030's score
adapter consumes the full result.

### Shell-side supervision codes (never on the wire)

The client marks failures it detected itself with codes that are
deliberately NOT worker error codes:

- `WORKER_CRASHED` — the process exited mid-job without a terminal event
  (the supervisor marks the job failed per ADR-0002; never silently
  resubmitted).
- `WORKER_UNRESPONSIVE` — the in-flight-job watchdog's `engine.ping`
  probe timed out (same handling as `debug.hang` engine-side).
- `REQUEST_TIMEOUT` — a request exceeded its response timeout.
- `ENGINE_UNAVAILABLE` / `ENGINE_NOT_READY` — the port could not spawn
  or the client is not in `ready` state.

### `project.open` [#365]

The authoritative project-open funnel — the shell must never re-implement
schema validation or migration client-side.

Request payload (one of):

- `{path: string}` — a `.hornscribe.json` path; the worker reads the file
  itself (nothing crosses the webview).
- `{documentBase64: string}` — UTF-8 JSON bytes, base64-encoded, for
  byte-opens with no durable path (File drops, autosave snapshots).

The raw document goes through `migrate_project_dict` then
`HornScribeProject.from_dict`, and the response carries the normalized
current-schema dict (root extras such as `scoreDocument`, `musicXmlConcert`,
`musicXmlHornF`, `reviewIssues`, `meta` preserved verbatim):

```json
{"path": "<path or ''>", "project": { "schemaVersion": 1, "projectId": "prj-...", "..." }}
```

Failure modes fail closed: unreadable path → `JOB_FAILED`; non-JSON,
non-object, malformed ids, or unsupported/newer `schemaVersion` →
`INVALID_PARAMS`. The shell maps every failure to its recoverable
`projectOpenFailed` surface.

`.recovery` fallback [#391]: for `{path}` opens, every failure of the
main document (unreadable, non-JSON, failed migration/validation)
retries the sibling `<name>.hornscribe.json.recovery` through the
identical funnel — the snapshot `project.save` leaves behind on every
successful write. A successful fallback sets `"recovered": true` on the
response so the shell can surface the restore and mark the document
dirty (the next `project.save` repairs the main file). When the sibling
is absent or also broken, the original main-file failure is returned.
`documentBase64` opens have no sibling and never set `recovered`.
This is distinct from the appData autosave snapshot: `.recovery` is the
previous explicitly-saved file, the autosave holds unsaved edits.
