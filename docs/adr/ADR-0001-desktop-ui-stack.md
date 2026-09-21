# ADR-0001: Desktop UI stack — Tauri 2 + React + TypeScript

- Status: Proposed
- Date: 2026-09-21
- Decision owners: HornScribe
- Related: ../GUI_UX_PLAN.md

## Context

HornScribe requires a desktop UI with:

- interactive MusicXML/SVG score rendering
- waveform/timeline interaction
- score/audio synchronization
- low-latency playback cursor updates
- AI confidence/review overlays
- Windows 11 visual quality
- keyboard-heavy professional workflows
- Japanese/English localization
- accessibility and HiDPI support
- complete local/offline operation

The original project plan assumed an all-Python PySide6 GUI. That remains viable for a conventional desktop UI, but HornScribe benefits strongly from the browser rendering ecosystem for SVG notation, waveform visualization, CSS design systems and accessibility semantics.

## Decision

Run a technical validation spike for:

- Tauri 2 as the desktop shell
- Rust for native lifecycle/process/filesystem integration
- React + TypeScript for the application UI
- Fluent UI React v9 as the component foundation
- HornScribe-owned semantic design tokens for final visual identity
- Verovio WASM for interactive score rendering
- wavesurfer.js for waveform/timeline rendering

This ADR remains **Proposed** until the Phase 0 spikes pass.

## Why React rather than Svelte

React is selected for the spike because Fluent UI React v9 is a first-party Microsoft implementation with mature accessibility behavior, component primitives, theming and Windows-oriented interaction patterns.

HornScribe should not look like a generic Fluent sample application. Fluent UI is a behavioral/component foundation; HornScribe design tokens, layout, density and music-specific surfaces remain custom.

## Consequences

Positive:

- high design freedom through HTML/CSS/SVG
- direct interaction with Verovio SVG
- straightforward waveform/canvas integration
- strong frontend testing ecosystem
- easier accessibility semantics than a fully custom canvas UI
- smaller desktop shell than Electron
- frontend can stay responsive when the Python ML process is busy or crashes

Costs:

- Rust + TypeScript + Python instead of one language
- IPC protocol must be designed and versioned
- WebView2 behavior must be tested explicitly
- frontend dependency supply chain must be kept controlled
- native Windows integration sometimes needs Rust/Tauri bridging

## Rejected as primary

### PySide6 / Qt Widgets

Excellent for Python integration and conventional controls, but a weaker fit for HornScribe's interactive SVG/waveform-centric UX without substantial custom drawing/styling work.

### Qt Quick / QML

Strong fallback. It remains the preferred alternative if Tauri/WebView2 fails the architecture spike.

### Electron

Technically suitable but heavier than necessary because Chromium/Node are bundled.

### WinUI 3

Excellent native Windows fit and accessibility, but increases custom integration work for interactive MusicXML/SVG and browser-oriented notation/waveform tooling.

## Validation gates

This ADR may become Accepted only if:

1. Tauri + Python sidecar packages successfully on Windows.
2. Verovio renders representative HornScribe MusicXML correctly.
3. Stable note element IDs can be mapped to canonical score IDs.
4. waveform pan/zoom/selection is smooth on representative audio lengths.
5. score ↔ audio bidirectional synchronization is perceptually accurate.
6. the application runs without runtime network/CDN dependencies.
7. keyboard and accessibility requirements can be met.
8. memory/startup performance stays within the GUI plan budget.

If a critical gate fails, evaluate Qt Quick/QML before expanding the Tauri codebase.
