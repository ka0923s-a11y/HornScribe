# ADR-0001: Desktop GUI architecture

- Status: Proposed — validate through UI Phase 0 spikes
- Date: 2026-09-21
- Decision owners: HornScribe project
- Related: ../GUI_UX_PLAN.md

## Context

HornScribe requires more than conventional desktop forms. Its primary interaction surfaces are an interactive MusicXML score, waveform/timeline, playback cursor, region selection, loop playback, AI-confidence overlays, note-level hit testing, keyboard-heavy review, and synchronized audio/score navigation.

The existing project plan initially assumed an all-Python PySide6 application. That is attractive for implementation simplicity but couples the ML runtime to the UI process and makes the desired SVG/waveform interaction layer more expensive to build and polish.

## Decision

Validate the following architecture as the preferred desktop stack:

~~~text
Tauri 2 / Rust
        |
React + TypeScript
Fluent UI React v9 + HornScribe design tokens
        |
Verovio WASM + wavesurfer.js
        |
Tauri command/event boundary
        |
Python engine sidecar
Basic Pitch / music21 / quantization / MusicXML / Horn in F
~~~

Python remains the canonical music/transcription engine.

The frontend must not reimplement transposition, quantization, MusicXML semantics or canonical score logic.

## Why React instead of Svelte

Svelte is technically viable and would reduce component boilerplate. React is preferred for HornScribe because Fluent UI React v9 is the official Fluent 2 React implementation and provides a mature component/accessibility baseline aligned with the Windows-first visual target.

HornScribe will still use its own semantic design tokens and will not look like an unmodified Microsoft business application.

## Why Tauri instead of Electron

Tauri uses the platform webview and provides native Rust capabilities and an explicit sidecar model. HornScribe benefits from browser SVG/WASM/Canvas capabilities but does not require shipping a full Chromium/Node runtime.

## Why not WinUI 3

WinUI 3 would provide the strongest native Windows control/accessibility integration. It is not selected because HornScribe depends heavily on interactive SVG notation, WebAssembly score rendering and web-oriented waveform libraries. Recreating those layers natively would materially increase implementation effort.

## Why not Qt Widgets

Qt Widgets remains useful for prototypes, but the intended highly customized visual system and interactive notation/timeline surface would require substantial custom styling/drawing.

## Fallback

If the spike reveals a blocking Tauri/WebView2 issue, the fallback is Qt Quick/QML, not Qt Widgets.

## Required validation before Accepted

UI Phase 0 must prove all of the following:

1. Tauri application packages and launches reliably on Windows.
2. Python sidecar handshake, progress, cancellation and crash recovery work.
3. Verovio renders HornScribe MusicXML and provides stable note-level interaction.
4. wavesurfer waveform/regions remain smooth on representative audio lengths.
5. score-to-audio and audio-to-score seek can share one transport clock without visible drift.
6. runtime operation is offline and does not rely on CDN resources.
7. keyboard, focus, accessibility semantics and Windows scaling are viable.
8. memory/startup overhead is acceptable.

If a blocking condition fails, document the result before changing the decision.

## Consequences

Positive:

- ML crashes can be isolated from the UI.
- frontend can be developed/tested without loading transcription models.
- Verovio/waveform ecosystem integrates directly.
- CSS/SVG design system enables high-fidelity polish.
- future transcription backends remain GUI-independent.

Costs:

- three implementation layers: TypeScript, Rust and Python.
- a versioned IPC protocol is required.
- packaging/testing becomes more complex.
- accessibility of custom score/waveform surfaces must be designed explicitly.

## Sources

- Tauri overview: https://v2.tauri.app/start/
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Fluent 2 development: https://fluent2.microsoft.design/get-started/develop
- Windows design: https://learn.microsoft.com/en-us/windows/apps/design/
- Windows accessibility: https://learn.microsoft.com/en-us/windows/apps/develop/accessibility
- Verovio: https://github.com/rism-digital/verovio
- Verovio WASM: https://book.verovio.org/installing-or-building-from-sources/javascript-and-webassembly.html
- wavesurfer.js: https://github.com/katspaugh/wavesurfer.js
