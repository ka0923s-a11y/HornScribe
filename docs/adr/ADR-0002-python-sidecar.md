# ADR-0002: Python music engine as an isolated sidecar process

- Status: Proposed
- Date: 2026-09-21
- Roadmap authority: ../MASTER_PLAN.md
- Related: ADR-0001-desktop-ui-architecture.md, ../DEVELOPMENT_PLAN.md, ../GUI_UX_PLAN.md

## Context

HornScribe depends on Python-oriented music and ML tooling:

- Basic Pitch baseline backend
- librosa / music analysis
- music21 / notation support
- future AMT backends
- FFmpeg and MuseScore orchestration

Keeping this runtime inside the GUI process would couple UI startup, dependency conflicts, crash behavior and Python lifecycle to the desktop interface.

Python runtime selection is itself under review because Python 3.10 reaches EOL in October 2026 while Basic Pitch 0.4.0 currently declares support through Python 3.11 and has active Python 3.12 work upstream.

## Proposed decision

Run the HornScribe music/transcription engine as an isolated Python worker process launched and supervised by Tauri.

The canonical concert-pitch score and project-domain transforms remain owned by Python.

The frontend consumes typed/versioned product-level messages rather than Python objects.

## Initial IPC

Use newline-delimited JSON over stdin/stdout.

Protocol rules:

- stdout = protocol frames only
- stderr/file = diagnostics/logging
- every request has an ID
- messages carry protocol version context
- long jobs emit structured progress events
- binary audio is referenced by local path/cache ID, not base64 JSON
- errors are structured data, not raw tracebacks
- unknown additive fields are ignored where safe
- incompatible major versions fail explicitly

## Why not local HTTP/gRPC initially

stdin/stdout requires no port, avoids firewall/network configuration, has a simple lifecycle, and is sufficient for control/progress traffic.

Re-evaluate only if later workloads require multiple clients or structured binary streaming.

## Cancellation model

A `jobs.cancel` protocol request does not prove that blocking ML inference is interruptible.

Validation order:

1. test cooperative cancellation with the real baseline backend
2. if inference cannot stop promptly, terminate/restart the worker as the MVP fallback
3. only if restart cost becomes unacceptable, introduce a persistent engine host with per-job child processes

Do not add a process hierarchy before measurements justify it.

## Runtime selection

Runtime choice is governed by FND-002.

The selected combination records:

- Python version
- dependency lock
- freeze/package method
- bundle size
- cold start
- model init
- inference time
- peak RAM
- offline execution
- cancellation behavior

## Failure model

If the worker crashes:

1. UI remains open
2. active job becomes failed/cancelled explicitly
3. autosaved project remains valid
4. diagnostics remain available
5. shell may restart worker
6. retranscription is never silently repeated

## High-frequency data rule

Playback/playhead updates do not pass through Python IPC at frame rate.

Transport timing belongs to the frontend/native playback subsystem. Python supplies stable mappings between seconds, beats and canonical note IDs.

## Acceptance criteria before Accepted

- handshake works in development and packaged build
- sidecar runtime is selected by FND-002 evidence
- clean shutdown and timeout handling work
- progress events stream reliably
- malformed protocol messages fail safely
- stdout stays protocol-clean even if dependencies emit logs
- worker crash is detected
- restart works without restarting GUI
- packaged app locates sidecar offline
- incompatible protocol major version fails clearly
- real backend cancellation behavior is documented
- project state survives worker failure

## Consequences

- schemas must be versioned
- frontend/backend types may later be generated from shared schema
- packaging is more complex than one Python process
- backend swap remains independent from GUI architecture
