# HornScribe

HornScribe is a personal, local-first application for transcribing audio into readable sheet music and generating an **F Horn (Horn in F)** version at the same time.

## Goals

- Run locally with no paid API or recurring cost.
- Keep source audio on the user's computer.
- Generate a readable concert-pitch score from audio.
- Generate a correct Horn in F written-pitch score from the same canonical music data.
- Export MusicXML and PDF; provide clearly defined MIDI playback/export semantics.
- Keep transcription, rhythm quantization, notation, instrument transposition, and presentation as separate stages.
- Allow future transcription backends without rewriting the application.

## Current status

Planning / architecture validation.

### Source-of-truth documents

1. **[Master Plan](docs/MASTER_PLAN.md)** — scope, milestones, gates, risks, and implementation order.
2. **[Development Plan](docs/DEVELOPMENT_PLAN.md)** — music engine, transcription, notation, Horn in F, export, and testing details.
3. **[GUI / UX Plan](docs/GUI_UX_PLAN.md)** — interaction design, visual system, accessibility, performance, and frontend architecture.
4. **[ADR-0001: Desktop UI Architecture](docs/adr/ADR-0001-desktop-ui-architecture.md)** — proposed Tauri/React architecture, pending spike validation.
5. **[ADR-0002: Python Sidecar](docs/adr/ADR-0002-python-sidecar.md)** — proposed Python engine process boundary.

If documents conflict, an **Accepted ADR** overrides the plans. Until an ADR is accepted, the Master Plan defines the active implementation sequence.

## Core architecture rule

HornScribe keeps **concert pitch as the canonical internal representation**.

For Horn in F:

```text
Concert C4
→ written Horn in F G4
→ MusicXML transposition metadata: -P5
→ sounding pitch C4
```

This prevents double-transposition errors and keeps transcription backends independent from instrument-specific notation.

## Proposed architecture

The music/transcription engine remains Python-based, while the desktop UI architecture is validated separately.

### Desktop / UI

- Tauri 2 / Rust shell
- React + TypeScript
- Fluent UI React v9 as a component/accessibility foundation
- HornScribe semantic design tokens
- Verovio WASM for interactive score rendering
- wavesurfer.js for waveform/timeline experiments

### Music / transcription engine

- Python runtime selected through a compatibility/packaging matrix; **Python 3.10 is not a long-term baseline**
- Spotify Basic Pitch as the initial AMT baseline, not a permanent hard dependency
- FFmpeg
- librosa / music21 where they materially reduce implementation risk
- MusicXML 4.0
- MuseScore Studio CLI for final PDF export
- pytest

The desktop stack becomes final only after the architecture spikes pass. Qt Quick/QML remains the documented fallback.

See the Master Plan for the current critical path and decision gates.
