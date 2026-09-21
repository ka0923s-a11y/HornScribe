# HornScribe

HornScribe is a personal, local-first application for transcribing audio into readable sheet music and generating an **F Horn (Horn in F)** version at the same time.

## Goals

- Run locally with no paid API or recurring cost.
- Keep source audio on the user's computer.
- Transcribe WAV/MP3 and later M4A/FLAC/OGG.
- Generate a concert-pitch score.
- Generate a correct Horn in F written-pitch score.
- Export MIDI, MusicXML, and PDF.
- Keep transcription, rhythm quantization, notation, and transposition as separate stages.
- Allow future transcription backends such as YourMT3+ without rewriting the application.

## Current status

Planning / architecture phase.

The project plans are documented here:

- **[Development Plan](docs/DEVELOPMENT_PLAN.md)** — transcription, notation, Horn in F, export, testing
- **[GUI / UX Design & Implementation Plan](docs/GUI_UX_PLAN.md)** — interaction design, visual system, accessibility, performance, frontend architecture
- **[ADR-0001: Desktop UI Architecture](docs/adr/ADR-0001-desktop-ui-architecture.md)** — proposed Tauri/React + Python worker boundary

## Core architecture rule

HornScribe keeps **concert pitch as the canonical internal representation**.

For Horn in F:

```text
Concert C4
→ written Horn in F G4
→ MusicXML transposition metadata: -P5
→ sounding pitch C4
```

This prevents double-transposition errors and keeps all transcription backends independent from instrument-specific notation.

## Planned architecture

The music/transcription backend remains Python-based, while the polished desktop UI is being validated as a separate frontend architecture.

### Desktop / UI

- Tauri 2 / Rust shell
- React + TypeScript
- Fluent UI React v9 + HornScribe design tokens
- Verovio WASM for interactive score rendering
- wavesurfer.js for waveform/timeline interaction

### Music / transcription backend

- Python 3.10 initially
- Spotify Basic Pitch baseline backend
- FFmpeg
- librosa
- music21
- MusicXML 4.0
- MuseScore Studio CLI
- pytest

The desktop architecture is **proposed until the technical spikes in the GUI/UX plan pass**. Qt Quick/QML is the documented fallback.

See the project plans for rationale, validation gates, and alternatives.
