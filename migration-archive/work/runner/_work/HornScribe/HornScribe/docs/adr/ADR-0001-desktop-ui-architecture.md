# ADR-0001: Desktop UI Architecture

- Status: Proposed — validate through architecture spikes before final acceptance
- Date: 2026-09-21
- Decision owners: HornScribe project
- Roadmap authority: ../MASTER_PLAN.md
- Related: ../GUI_UX_PLAN.md

## Context

HornScribe requires more than conventional desktop forms and dialogs.

Its critical interaction surfaces are:

- interactive MusicXML/SVG score rendering
- note-level selection and highlighting
- waveform navigation
- region selection and looping
- synchronized score/audio playback
- review of uncertain transcription results
- responsive dark/light/high-contrast themes
- keyboard-first workflows
- local Python ML/music-processing dependencies

The original plan assumed PySide6 for the entire application. That is still technically viable, but it couples the GUI runtime to the ML environment and increases custom work for interactive SVG notation, waveform/timeline rendering and visual polish.

## Proposed decision

Prototype and, only if the validation gates pass, adopt:

- Tauri 2 as desktop/native shell
- React + TypeScript frontend
- Fluent UI React v9 as component/accessibility foundation
- HornScribe semantic design tokens for final visual identity
- Verovio WASM for interactive score rendering
- wavesurfer.js 7.x initially for waveform/timeline experimentation
- isolated Python engine sidecar
- versioned newline-delimited JSON IPC over stdin/stdout initially

Python remains the authority for canonical concert-pitch music data.

The frontend must not reimplement Horn transposition, quantization, MusicXML semantics, or score identity/provenance rules.

## Local media boundary

Preferred flow:

```text
user-selected source audio
→ Rust/Python backend ownership
→ normalized playback/cache artifact
→ narrowly scoped Tauri asset protocol
→ waveform/transport
```

The WebView should not receive broad filesystem access merely to play arbitrary source files.

## Validation gates

This ADR remains **Proposed** until all evidence exists.

### Gate A — shell / packaging / security

- packaged Windows application launch
- light/dark/system theme
- 100/150/200% scaling sanity
- no runtime CDN dependency
- restrictive CSP
- narrow Tauri capabilities
- local playback cache through constrained asset scope
- acceptable cold-start and memory measurements

### Gate B — Python engine boundary

- packaged sidecar launch
- protocol handshake and request correlation
- progress and timeout handling
- worker crash detection/restart
- stdout protocol / stderr diagnostics separation
- real inference cancellation behavior measured, not assumed

### Gate C — Verovio

- Concert and Horn MusicXML rendering
- canonical note ID → MusicXML ID → rendered element mapping
- click → canonical note mapping
- playback time → note highlight
- selection/highlight without full score rerender
- viable DPI/accessibility strategy

### Gate D — waveform / transport

Measure:

- 30 sec / 3 min / 10 min local audio
- seek latency
- playhead jitter
- loop drift
- playback-rate and pitch-preservation behavior
- memory use
- pan/zoom/region interaction

### Gate E — unified timeline

- waveform click → score context
- score click → audio seek
- Concert/Horn switch preserves canonical selection/time
- follow/suspend/resume behavior
- measured synchronization error on deterministic fixtures
- no full React/Verovio rerender at playback frame rate

## Rejection criteria

Reject this architecture and run a bounded Qt Quick/QML fallback spike if one or more cannot be reasonably mitigated:

- unstable WebView2/Verovio interaction
- accessibility blocker
- unacceptable local-media timing
- unacceptable sidecar packaging complexity
- unacceptable startup/memory cost
- security requires overly broad filesystem/WebView permissions

Do not maintain Tauri and Qt production frontends in parallel.

## Consequences

Positive:

- strong SVG/WASM/waveform ecosystem
- visual regression and component testing
- ML/runtime failure isolation
- frontend independent from specific AMT models

Costs:

- Rust + TypeScript + Python
- versioned IPC contracts
- additional packaging complexity
- WebView2 behavior must be measured
- custom score/waveform accessibility is still required

## Non-negotiable rules

1. Canonical score data is concert pitch.
2. Canonical note identity belongs to the music domain, not SVG DOM IDs.
3. No F-Horn transposition logic is duplicated in React.
4. Raw transcription data is non-destructive.
5. Audio is never uploaded.
6. Heavy work never blocks the frontend.
7. Protocol stdout contains protocol only.
8. Frontend filesystem capabilities remain narrow.
9. Architecture may be rejected if spike evidence fails.

## References

- Master Plan: ../MASTER_PLAN.md
- Tauri: https://v2.tauri.app/
- Tauri sidecar: https://v2.tauri.app/develop/sidecar/
- Tauri CSP: https://v2.tauri.app/security/csp/
- Tauri asset protocol: https://v2.tauri.app/security/asset-protocol/
- Qt Quick: https://doc.qt.io/qt-6/qtquick-index.html
- Verovio: https://www.verovio.org/
- wavesurfer.js: https://github.com/katspaugh/wavesurfer.js
- Fluent UI: https://github.com/microsoft/fluentui
