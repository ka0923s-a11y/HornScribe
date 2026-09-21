# ADR-0001: Desktop UI Architecture

- Status: Proposed — validate through architecture spikes before final acceptance
- Date: 2026-09-21
- Decision owners: HornScribe project
- Related: ../GUI_UX_PLAN.md

## Context

HornScribe requires more than conventional desktop forms and dialogs.

The product needs:

- interactive MusicXML/score rendering
- note-level selection and highlighting
- waveform navigation
- region selection and looping
- synchronized audio/score playback
- optional spectrogram and raw-note overlays
- review of uncertain transcription results
- responsive dark/light/high-contrast themes
- high-quality Windows 11 visual integration
- keyboard-first workflows
- local Python ML/music-processing dependencies

The original project plan assumed PySide6 for the entire application.

That remains a viable implementation path, but it couples the UI runtime to the ML/music Python environment and makes the most interaction-heavy parts of the product more expensive to implement.

## Decision

Prototype and, if the required spikes pass, adopt:

- Tauri 2 as the desktop/native shell
- React + TypeScript as the frontend
- Fluent UI React v9 as the component foundation
- HornScribe-specific design tokens on top of Fluent
- Verovio WASM for interactive score rendering
- wavesurfer.js for waveform/timeline interaction
- Python as an isolated worker sidecar for transcription, quantization, notation, Horn in F transformation, and export
- newline-delimited JSON over stdin/stdout as the initial IPC transport

Python remains the source of truth for the canonical concert-pitch score model.

The frontend must not implement independent transposition or notation business logic.

## Why

### Interactive notation

Verovio's web/WASM build produces SVG and exposes element/time mapping APIs. A browser DOM makes note selection, CSS highlighting, pointer interaction, and accessibility overlays straightforward.

### Audio timeline

The browser ecosystem provides mature waveform, region, timeline, and WebAudio/media primitives. This is a better fit for HornScribe's review workflow than building a timeline widget from scratch.

### Visual quality

React + CSS + Fluent UI provides tight control of typography, spacing, themes, states, motion, and responsive layout.

### Runtime isolation

A transcription model crash or dependency conflict should not crash the UI process.

The UI must remain responsive while the Python worker performs long-running tasks.

### Future models

The UI communicates with a stable capability/protocol boundary rather than importing a specific transcription model.

## Why not Electron

Electron provides the same general web UI advantages but bundles a larger Chromium/Node runtime. HornScribe does not currently require capabilities that justify this additional runtime footprint over Tauri.

## Why not PySide6 Widgets

PySide6 remains excellent for a fast Python prototype, but achieving the desired score/waveform interactions and highly polished custom UI would require more custom rendering and styling.

## Why not Qt Quick/QML

Qt Quick is the preferred fallback if Tauri is rejected.

It offers a GPU-accelerated scene graph and mature desktop support. However, HornScribe would need more bridging/custom work to take advantage of the browser-oriented notation/waveform ecosystem.

## Why not WinUI 3

WinUI 3 offers the strongest Windows-native Fluent integration, but HornScribe would still need an IPC boundary to Python and additional integration for the interactive score and waveform stack.

The product also benefits from preserving a future cross-platform path.

## Validation gates

This ADR remains Proposed until all four spikes pass.

### Spike A — Tauri + Python worker

Must demonstrate:

- packaged application launch
- protocol handshake
- request/response
- progress events
- cancellation
- worker crash detection/restart
- clean separation of protocol stdout and diagnostic stderr

### Spike B — Verovio

Must demonstrate:

- MusicXML rendering
- stable note/element IDs
- click → canonical element mapping
- playback time → visible note highlight
- Concert/Horn view switching without losing context

### Spike C — Waveform

Must demonstrate:

- 3–10 minute audio
- smooth pan/zoom
- seek
- region selection
- loop handles
- playback speed
- pitch-preserving playback where supported

### Spike D — Unified timeline

Must demonstrate:

- waveform click → score position
- score click → audio seek
- loop region → score range
- smooth playback cursor
- reliable timing mapping

## Rejection criteria

Reject this decision and evaluate Qt Quick/QML if one or more of the following is demonstrated and cannot be reasonably mitigated:

- unstable Verovio/WebView2 interaction
- accessibility blockers
- unacceptable Python sidecar packaging complexity
- audio/score timing cannot meet product requirements
- unacceptable memory or startup characteristics

## Consequences

### Positive

- UI development is independent from Python ML dependencies
- strong interactive SVG and waveform ecosystem
- easier visual polish
- frontend can be visually regression-tested
- worker failures are isolated
- future transcription backends remain replaceable

### Negative

- three implementation languages: Rust, TypeScript, Python
- explicit IPC protocol must be versioned and tested
- packaging is more complex
- developers must understand frontend/backend ownership boundaries

## Non-negotiable architecture rules

1. Canonical score data is concert pitch.
2. Python domain logic remains authoritative.
3. No F-Horn transposition logic is duplicated in React.
4. Raw transcription data remains non-destructive.
5. Audio files are never uploaded by the UI.
6. Heavy work never blocks the frontend.
7. Protocol logs never share stdout with JSON messages.
8. The architecture can be reversed to Qt Quick if spike evidence requires it.

## References

- Tauri: https://v2.tauri.app/
- Tauri sidecar: https://v2.tauri.app/develop/sidecar/
- Qt Quick: https://doc.qt.io/qt-6/qtquick-index.html
- WinUI: https://learn.microsoft.com/windows/apps/winui/
- Verovio: https://www.verovio.org/
- wavesurfer.js: https://wavesurfer.xyz/
- Fluent 2: https://fluent2.microsoft.design/
