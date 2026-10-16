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
- **The user-facing application UI is Japanese-only.** English UI and a language switcher are intentionally out of scope.

## Current status

Shipping. Pre-release installers and portable builds publish under
[Releases](https://github.com/ka0923s-a11y/HornScribe/releases) (currently v0.2.x).

Implemented end to end:

- Transcription from audio files, microphone recording, and PC
  (loopback) audio capture.
- Concert-pitch score plus Horn in F and B-flat written-pitch views
  and exports (MusicXML 4.0, PDF print path, MIDI).
- Automatic JPOP-mix handling: vocal isolation (built-in center
  extraction, optional free demucs add-on tiers), a separation-
  derived accompaniment staff, melody/accompaniment review.
- Interactive score review workspace — engine-flagged review issues
  with one-click remedies, source A-B-loop audition, score playback,
  editing (split/merge/transpose/delete notes, pickup/meter/key
  properties).
- Local-only operation: no account, no cloud, no paid service.

### Source-of-truth documents

1. **[Master Plan](docs/MASTER_PLAN.md)** — scope, milestones, gates, risks, and implementation order.
2. **[Development Plan](docs/DEVELOPMENT_PLAN.md)** — music engine, transcription, notation, Horn in F, export, and testing details.
3. **[GUI / UX Plan](docs/GUI_UX_PLAN.md)** — GUI research, framework rationale, and architecture background.
4. **[GUI / UX Product Specification](docs/GUI_UX_SPEC.md)** — authoritative screens, interactions, state transitions, and keyboard behavior.
5. **[Design System](docs/DESIGN_SYSTEM.md)** — authoritative visual tokens and component rules.
6. **[UX Validation](docs/UX_VALIDATION.md)** — usability, accessibility, performance, and regression gates.
7. **[Quantizer Design](docs/QUANTIZER_DESIGN.md)** — HSQ-v1 rhythm quantization algorithm, cost model, tests, and implementation phases.
8. **[ADR-0001: Desktop UI Architecture](docs/adr/ADR-0001-desktop-ui-architecture.md)** — proposed Tauri/React architecture, pending spike validation.
9. **[ADR-0002: Python Sidecar](docs/adr/ADR-0002-python-sidecar.md)** — proposed Python engine process boundary.
10. **[Japanese UI Copy](docs/JAPANESE_UI_COPY.md)** — copy standard for the Japanese-only UI.
11. **[UI Copy Contract](docs/UI_COPY_CONTRACT.md)** — canonical `protocol/copy/ja-JP.json` deck rules and `fixtures/ui/` format.

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

The music/transcription engine is Python-based (sidecar worker); the
desktop UI architecture below is what shipped.

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

The desktop stack shipped as listed above. Qt Quick/QML remains the
documented fallback.

See the Master Plan for the current critical path and decision gates.
