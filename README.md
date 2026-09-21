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

The implementation plan, technical decisions, test strategy, MusicXML transposition rules, and phased Codex task list are documented here:

**[Development Plan](docs/DEVELOPMENT_PLAN.md)**

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

## Planned MVP stack

- Python 3.10
- PySide6
- FFmpeg
- Spotify Basic Pitch
- librosa
- music21
- MusicXML 4.0
- MuseScore Studio CLI
- pytest

See the development plan for the rationale and alternatives.
