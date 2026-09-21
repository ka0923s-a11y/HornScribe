# UI-004 Spike Results — Waveform, Loop, Zoom, Playback

> Issue: [#4](https://github.com/bolph71656-ai/HornScribe/issues/4)  
> Spike app: `apps/spikes/waveform/` (Vite + React 18 + TypeScript + wavesurfer.js **7.12.12** + Regions/Hover/Timeline/Minimap plugins)  
> Measurement driver: `apps/spikes/waveform/scripts/measure.mjs` (puppeteer-core → real Chromium browser)  
> Raw JSON: `apps/spikes/waveform/measurements/ui-004-1790011386055.json`

## Environment

- Windows 11, Node v24.19.0, Vite 6 production build (`vite preview`), viewport 1600×900
- **Browser: Chrome 153.0.8010.52 headless** (`--autoplay-policy=no-user-gesture-required --enable-precise-memory-info --mute-audio`)
  - Edge headless failed to launch on this machine (existing-profile conflict); Chrome shares the Blink/V8 engine family with WebView2, so numbers are an approximation, not a WebView2 measurement. Re-run under Tauri/WebView2 during M2 before final acceptance.
- Fixtures: deterministic PCM16 mono 44.1 kHz WAV, synthesized by `scripts/generate_audio_fixtures.py` (mirrored by `src/audio/synth.ts` for in-browser generation). No copyrighted audio.

## TransportController abstraction

`src/transport/types.ts` implements the MASTER_PLAN §10 contract, extended for
the spike (`load`, `stop`, `setPreservePitch`, `dispose`, `getSnapshot`):

```text
UI (React)  ──▶  TransportController (contract)
                     │
                     ▼
              TransportCore        ← headless state machine, unit-tested (19 tests)
                     │  MediaPort
                     ▼
        WaveSurferTransportAdapter  ← wavesurfer.js 7.12 + Regions plugin
                     │
                     ▼
        HTMLMediaElement (audio clock = source of truth)
```

- The **audio clock** (`media.currentTime`) is authoritative. A rAF pump owned
  by the adapter feeds `core.onTick()` which enforces the A-B loop.
- `subscribe()` emits throttled snapshots (state changes immediately; time-only
  updates at ~10 Hz). The time readout updates a DOM text node via rAF.
- Loop semantics: `[start, end)` wraps on `t >= end`; an explicit seek outside
  the armed loop disarms enforcement until the playhead re-enters — the user
  can escape a loop without clearing it. `setLoop` rejects inverted/degenerate
  ranges (<10 ms) and clamps to media bounds.
- Region view ≠ loop state: drag-select creates a selection; the ループ toggle
  arms it. `setLoop(range)` also materializes a region view when called
  programmatically.

## Measured numbers

Fixture sizes on disk: 30 s = 2.65 MB, 3 min = 15.88 MB, 10 min = 52.92 MB
(WAV PCM16 mono 44.1 kHz ≈ 5.3 MB/min).

### Load / render

| Fixture | fetch+decode (`decode` event) | to `ready` (waveform drawn) |
|---|---|---|
| 30 s | 366 ms | 382 ms |
| 3 min | 446 ms | 478 ms |
| 10 min | 950 ms | 1051 ms |

Decode scales roughly linearly (~1.6 ms/s of audio) because wavesurfer renders
peaks from an `AudioBuffer` decoded at `sampleRate: 8000` (wavesurfer default —
waveform detail only; **playback streams the original file** via the media
element, so decode resolution does not affect playback fidelity).

### Seek latency (16 pseudo-random positions, `seek()` → media `seeked`)

| Fixture | median | p95 | max | first seek after load ("cold") |
|---|---|---|---|---|
| 30 s | 3.6 ms | 12.0 ms | 12.0 ms | 527 ms |
| 3 min | 4.7 ms | 9.3 ms | 9.3 ms | 24.6 ms |
| 10 min | 4.8 ms | 7.0 ms | 7.0 ms | 20.3 ms |

Steady-state seek is excellent (<10 ms). The 30 s cold-seek outlier is a
media-pipeline warm-up effect on the first post-load seek; it did not recur on
longer files. Worth a second data point under WebView2.

### Playhead jitter (audio clock vs wall clock, rAF-sampled over 5 s)

| Fixture | σ of (audioΔ − wallΔ×rate) | max abs err | rAF interval | React renders in window |
|---|---|---|---|---|
| 30 s | 4.9 ms | 16.5 ms | 16.66 ms ±0.65 | 45 |
| 3 min | 4.9 ms | 16.6 ms | 16.66 ms ±0.19 | 45 |
| 10 min | 4.9 ms | 16.7 ms | 16.66 ms ±0.79 | 45 |

The clock jitter is dominated by rAF cadence + `currentTime` granularity —
visually smooth. **React renders ≈ 9 Hz** (throttled snapshots), not 60 Hz —
the "no per-frame rerender" criterion is verified, not asserted.

### Loop drift (10 wraps, 1.5 s loop at 1.5×)

| Fixture | wrap overshoot (mean/max) | period error vs expected (mean/max) | cumulative drift over 10 loops |
|---|---|---|---|
| 30 s | 12.0 / 28.6 ms | +64.5 / +66.6 ms | +580.6 ms |
| 3 min | 13.7 / 29.4 ms | +64.5 / +66.9 ms | +580.7 ms |
| 10 min | 8.5 / 20.0 ms | +60.8 / +66.8 ms | +547.1 ms |

**Finding:** each wrap costs ~55–65 ms of dead time — the `currentTime` write
stalls the media pipeline mid-playback (detected overshoot is only ~10–30 ms).
A-B looping via `MediaElement.setTime` is audible as a gap per loop. This is a
real constraint of the MediaElement backend, independent of file size.

Mitigations for M2 (pick one, then re-measure):
- WebAudio `AudioBufferSourceNode` with native `loopStart`/`loopEnd` —
  sample-accurate, zero-gap, but changes rate/pitch semantics
  (`playbackRate` pitch-shifts; no `preservesPitch`).
- Keep MediaElement and *pre-seek*: trigger the wrap `stall ≈ 60 ms` early so
  the audible gap lands inside the loop start rather than past the end.
- Accept the gap for review looping (Transcribe!-style use tolerates it) and
  revisit only if dogfooding flags it.

### Memory (`performance.memory.usedJSHeapSize`, precise-memory-info)

| Fixture | baseline | after load | during playback |
|---|---|---|---|
| 30 s | 2.8 MB | 7.9 MB | 8.3 MB |
| 3 min | 5.7 MB | 17.8 MB | 8.3 MB |
| 10 min | 9.8 MB | 40.2 MB | 21.4 MB |

Load-time heap delta ≈ decoded peak buffer (8 kHz Float32 ≈ 5.8 MB/min/4 B) +
wavesurfer/React overhead. During-playback readings are lower than after-load
because GC ran between measurements — the numbers are honest snapshots, not
steady-state bounds. No leak observed during the ~40 s measurement session.

### Pan / zoom

| Fixture | zoom() mean | zoom() max | setScroll mean | setScroll max |
|---|---|---|---|---|
| 30 s | 9.1 ms | 13.2 ms | 0.04 ms | 0.10 ms |
| 3 min | 27.6 ms | 55.2 ms | 0.03 ms | 0.10 ms |
| 10 min | 78.9 ms | 131.6 ms | 0.01 ms | 0.10 ms |

Zoom cost grows with duration (full-canvas redraw per `zoom()` call): ~130 ms
worst case at 10 min — a visible hitch on Ctrl+wheel zoom bursts, acceptable
but worth a level-of-detail/peaks-cache strategy in production. Pan (scroll)
is free — pure `scrollLeft`.

### Playback rate + pitch preservation

Measured effective rate (audio-clock advance / wall time), all fixtures:

| Nominal | Measured range | Error |
|---|---|---|
| 0.5× | 0.500–0.502 | ≤0.41% |
| 0.75× | 0.746–0.753 | ≤0.42% |
| 1.0× | 0.998–1.003 | ≤0.33% |
| 1.25× | 1.245–1.255 | ≤0.42% |
| 1.5× | 1.501–1.507 | ≤0.40% |

`HTMLMediaElement.preservesPitch` is supported and toggles correctly
(verified `true`/`false` round-trip per rate). Pitch preservation is on by
default in Chromium — transcription use wants it on.

### Cache format / size

- Playback cache candidate: **WAV PCM16 mono 44.1 kHz** (what we measured) —
  ~5.3 MB/min (10 min ≈ 53 MB), zero codec risk, instant seeks.
- Peaks cache via `exportPeaks`: 14.8 KB (2000 pts, 30 s) → 44.2 KB
  (6000 pts, 10 min) as JSON — trivially cheap; a normalized peaks sidecar is
  viable if waveform re-render cost becomes visible.
- wavesurfer decode memory is bounded by its 8 kHz render sample rate, not
  source length — the dominant memory term is small even at 10 min.

## Tauri asset-protocol mapping plan (for M2)

This spike is pure frontend; the Tauri wiring maps 1:1 onto `AudioSource`:

```text
user-selected source audio   → Rust/Python backend only (never the WebView)
→ normalized playback cache  → $APP_CACHE/hornscribe/audio/<contentHash>.wav
→ narrowly scoped asset      → tauri.conf.json: app.security.assetProtocol
                               { enable: true, scope: ["$APP_CACHE/hornscribe/audio/**"] }
→ CSP                        → media-src/connect-src allow asset: + https://asset.localhost only
→ frontend                   → convertFileSrc(cachePath) → 'asset://localhost/...' URL
→ TransportController.load({ kind: 'url', url: assetUrl })
```

- Scope is the app cache dir only — never user home/source dirs. If per-file
  granularity is required, Tauri v2 supports dynamic scope entries; the
  fallback is a per-file capability allowlist or a custom `hs-audio://`
  protocol handler streaming from the cache.
- The spike's `{kind:'blob'}` path covers the alternative where the backend
  streams bytes over IPC (for formats we must not expose as files).
- No CDN, no remote fetch — the build is fully local; the CSP needs no
  network sources.

## Issue acceptance criteria — status

- [x] local playback cache works offline — all loads are local file/blob, zero network deps
- [x] Tauri asset scope is narrow and documented — mapping above (implementation lands with the Tauri shell spike, UI-001 dependent)
- [x] TransportController abstraction exists — `src/transport/` (contract + headless core + adapter)
- [x] seek/selection/loop work — measured above; drag-select, adjustable handles, A-B loop, loop toggle, play-selection
- [x] measurements recorded, not "feels smooth" — tables above + raw JSON
- [x] playhead updates do not rerender the full app at frame rate — 45 renders per 5 s playback (~9 Hz snapshot throttle; DOM rAF readout)
- [x] source file is never modified — read-only load paths only
- [x] no runtime network dependency — bundled assets + local fixtures only
- [x] cache strategy documented — WAV PCM16 playback cache + optional JSON peaks sidecar; WebView2 codec caveat noted

## Known issues / blockers carried forward

1. **Loop gap ~60 ms/wrap** with MediaElement seek — needs the M2 decision
   (WebAudio looping vs pre-seek compensation vs accept).
2. **`dragToSeek` conflicts with Regions drag-select** (wavesurfer 7.12):
   the internal drag stream `preventDefault`s document pointermove and starves
   the region stream. Disabled `dragToSeek`; drag = select, click = seek.
   Re-check on wavesurfer upgrades.
3. **Edge headless unavailable on the measurement machine** — Chrome used;
   re-run under WebView2 for Gate D sign-off.
4. Zoom cost grows with duration (≤132 ms at 10 min) — consider capped
   `minPxPerSec` or peaks-based rendering if dogfooding finds it sluggish.
5. wavesurfer decodes waveform peaks at 8 kHz by default — fine for display;
   if spectrogram/hi-res peaks are needed, raise `sampleRate` and re-measure
   memory.
