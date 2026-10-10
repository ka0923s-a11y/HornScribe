# HornScribe IPC protocol draft

> Status: Draft contract for the UI-002 spike.
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
