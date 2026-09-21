# ADR-0002: Python music engine as an isolated sidecar process

- Status: Proposed
- Date: 2026-09-21
- Related: ADR-0001, ../DEVELOPMENT_PLAN.md, ../GUI_UX_PLAN.md

## Context

HornScribe's transcription and notation stack depends heavily on Python libraries and models:

- Basic Pitch
- librosa
- music21
- MIDI/MusicXML processing
- future AMT backends
- FFmpeg/MuseScore orchestration

Keeping these packages in the same process as the desktop UI would couple GUI startup, crash behavior, dependency resolution and Python runtime constraints to the ML stack.

## Decision

Run the HornScribe music/transcription engine as an isolated Python worker process launched and supervised by Tauri.

The desktop frontend never imports or reimplements musical-domain logic.

The canonical concert-pitch score remains owned by the Python domain layer.

## Initial IPC

Use newline-delimited JSON messages over stdin/stdout.

Protocol rules:

- stdout contains protocol messages only
- logs use stderr
- every request has an ID
- messages include a protocol version
- long jobs emit structured progress events
- jobs can be cancelled
- binary audio is referenced by local path/cache ID rather than encoded into JSON
- user-visible errors are structured data, not raw Python tracebacks

## Rationale

This approach is preferred initially over local HTTP/gRPC because it:

- requires no port
- avoids firewall prompts
- has simple one-parent/one-worker lifecycle
- is easy to inspect in tests
- is sufficient for request/response/progress traffic
- keeps audio and model data on local storage

## Failure model

If the worker crashes:

1. the UI remains open
2. the active job becomes failed
3. existing project/autosave state is preserved
4. diagnostics expose the worker log
5. the shell can restart the worker
6. retranscription is explicit, not silently repeated

## Consequences

- frontend and backend schemas must be versioned
- code generation from a shared JSON Schema may be useful later
- progress/cancellation semantics must be consistent across transcription backends
- high-frequency playback state must not flow through this IPC; playback is a frontend/native transport concern

## Acceptance criteria before status becomes Accepted

- handshake works in development and packaged build
- process shutdown is clean
- timeout is handled
- progress events stream reliably
- cancellation is deterministic
- worker crash is detected
- restart works without restarting the GUI
- stderr is not mixed with protocol output
- incompatible protocol versions fail with a clear diagnostic
