# UI-005 Spike Results — Unified score ⇔ audio synchronization

> Issue: [#5](https://github.com/bolph71656-ai/HornScribe/issues/5)
> Spike app: `apps/spikes/score-audio-sync/` (Vite + React 18 + TypeScript + Verovio 6.3 + wavesurfer.js 7.12.12)
> Measurement driver: `apps/spikes/score-audio-sync/scripts/measure.mjs` (puppeteer-core → real Chromium browser, in-page harness `src/measure/harness.ts`)
> Raw JSON: `apps/spikes/score-audio-sync/measurements/ui-005-1790014607639.json`

## Environment

- Windows 11, Node v24.19.0, Vite 6 production build (`vite preview`), viewport 1600×900
- **Browser: Chrome headless** (`--autoplay-policy=no-user-gesture-required --mute-audio --disable-renderer-backgrounding`) — same Blink/V8 family as the WebView2 target; Edge headless unavailable on this machine (UI-004 finding carried forward). Re-run under Tauri/WebView2 before Gate D sign-off.
- Score fixtures: committed generated MusicXML pair — `apps/spikes/score-audio-sync/fixtures/sync_concert.musicxml` + `sync_horn_in_f.musicxml` (12 bars, 4/4, 100 BPM, divisions=480, **40 canonical notes**, 3 ties incl. a 3-fragment chain, 2 rests, identical `hs-sn-*` ids across presentations). Generator: `scripts/gen-fixtures.mjs`.
- Audio: synthesized in-app per fixture (`src/audio/synth.ts` → PCM16 WAV blob) — one decaying sine per canonical span **mapped through the warp**, plus a click transient at every onset. Zero binary fixtures; fully offline.
- Two clock-domain fixtures sharing the same score:
  - `steady`: `fixed_bpm` warp, 100 BPM, 0.4 s lead-in → 30.0 s audio.
  - `warped`: `beat_map` warp — piecewise-linear anchors at every barline with a rallentando (2.4 s/bar → 4.2 s/bar) → 40.3 s audio. Proves sync runs through the beat map, not a constant-rate shortcut.

## Architecture: one clock, canonical identity chain

```text
React UI (toolbar, panels — throttled snapshot mirror only)
   │ subscribe() ~10 Hz                     ▲ DOM class toggles (hs-*)
   ▼                                        │
TransportController ── TransportCore ── MediaPort ── wavesurfer/HTMLMediaElement
   │                    (authoritative clock: media.currentTime, rAF pump)
   ▼
ScoreSyncEngine = SyncMap (MusicXML → exact ql spans, canonical sn-* ids)
                × TimeWarp (seconds ↔ ql; fixed_bpm | beat_map piecewise)
```

- **audio seconds ↔ ql**: `src/sync/timewarp.ts` mirrors the Python contract
  (`rhythm/timewarp.py`, `beatmap.py`) — linear `ql=(t−zero)·bpm/60`, or
  piecewise-linear anchors with nearest-segment extrapolation. Positions are
  exact `Rational` (BigInt fraction); seconds are floats. `qlToSeconds`
  rejects floats, mirroring the Python rule.
- **ql ↔ canonical ↔ rendered**: `src/sync/syncMap.ts` parses MusicXML
  `<duration>`/`<divisions>` into exact ql spans keyed by canonical id
  (`hs-sn-NNNNNN(-k)` → `sn-NNNNNN`; `hs-rest-*` advances the cursor only).
  Rendered-element lookup is by `hs-*` id — the FND-001 stable ids; random
  Verovio ids are never used as identity.
- **Cross-check**: `src/sync/syncMap.verovio.test.ts` asserts every fragment
  onset in our map equals Verovio's own `getTimeForElement` (≤ 1 ms) — the
  DOM-side map and the rendered view's clock provably agree; the app still
  uses only the ql side for sync.
- **Highlight path is DOM-only**: `hs-active` / `hs-selected` / `hs-loop`
  class toggles + a `hs-measure-wash` rect on the containing measure group.
  The playhead pump runs on rAF against the media clock directly; React
  state changes only when the active canonical *set* changes.
- **Follow mode**: app-owned `scrollIntoView` on the active fragment.
  Manual score navigation (wheel / scrollbar / paper pointerdown) or
  waveform pan **suspends** follow; only the explicit 追従を再開 button
  (or the follow checkbox) resumes it. Waveform *clicks* deliberately do
  not suspend — a seek should keep following from the new position.
- **Concert ↔ F管**: re-renders Verovio from the other presentation; the
  SyncMap/engine are untouched (same canonical structure, verified in
  tests), selection re-applies by canonical id, transport is never paused
  or re-seeked — the audio clock simply keeps running.

## Unit tests (UI-independent, per the ticket)

`vitest run` → **54 tests, all green**:

- `sync/rational` + `timewarp` (12): exact rational math, `Fraction(float)`
  semantics, fixed-bpm map, anchor interpolation/extrapolation, beat-map
  validation (`InvalidBeatMapError` mirror), monotonicity.
- `syncMap` (7): parses the committed fixture to the exact known onset
  table, merges non-adjacent tie fragments into one canonical span,
  measures/rests/duration, horn presentation identity, midi extraction.
- `syncMap.verovio` (3): our ql map == Verovio timemap for all 44 fragments.
- `syncEngine` (13): active-at boundaries, ties, rest gaps, nearest-note
  resolution, loop → canonical/measure passage (incl. documented
  seconds-boundary float noise), seek targets.
- `transport/core` (19, carried from UI-004): state machine, loop arm/disarm,
  wrap enforcement, throttle contract.

## Measured numbers (production build, headless Chrome)

Both fixtures measured; where they agree within noise, the `steady` column is
quoted with `warped` in parentheses.

### Score click → audio seek (all 40 canonical notes)

| Fixture | median | p95 | mean | max |
|---|---|---|---|---|
| steady | 3.8 ms | 5.7 ms | 4.6 ms | 28.4 ms |
| warped | 3.6 ms | ~5 ms | ~4 ms | — |

Path: rendered `g[id^=hs-]` → `canonicalNoteIdFromMusicxml` → span onset ql →
`warp.qlToSeconds` → `transport.seek` (awaits media `seeked`). Sub-5 ms
median — the chain is effectively free; the max is a cold-seek warm-up
blip on the first click.

### Waveform click → score highlight (24 pseudo-random times)

| Fixture | median | p95 | correct selections |
|---|---|---|---|
| steady | 1.1 ms | 1.7 ms | **24/24** |
| warped | ~1 ms | ~2 ms | 24/24 |

Seconds → `nearestCanonicalAtSeconds` → canonical id → `hs-selected` class.
Synchronous; sub-frame. Verified correct against the engine's own answer —
the DOM mark and the map never disagree.

### Playback sync error (rAF-sampled over 6 s of real playback)

| Metric | steady | warped |
|---|---|---|
| Frames sampled | 361 | 361 |
| **DOM `hs-active` vs expected set mismatches** | **0** | **0** |
| Note boundaries crossed | 11 | 11 |
| Boundary lag (audio clock at DOM update) | mean 0.0 ms, max 0.0 ms | 0.0 ms |
| React renders in window | 66 (~11 Hz) | 65 (~11 Hz) |
| `renderToSVG` calls in window | **0** | **0** |

The DOM highlight set equals the engine's expected set on **every sampled
frame** for both warps — the pump applies marks the same frame the boundary
crosses. React renders ≈ 11 Hz (10 Hz snapshot throttle + one render per
note boundary), never 60 Hz; Verovio is never re-rendered during playback.
Both hard criteria are measured, not asserted.

### Follow scroll + highlight DOM cost

| Path | calls | mean | max |
|---|---|---|---|
| `scrollIntoView` on active fragment | 11 | 0.49 ms | 0.80 ms |
| `hs-active` class retoggle | 12 | 0.38 ms | 1.20 ms |

Follow cost is one `scrollIntoView` per note-boundary change — sub-ms, no
layout storm. Manual wheel/pointerdown navigation suspends follow
(`followSuspended` state + `追従を再開` button); verified interactively.

### Loop → score passage (armed range shown on the score)

| Fixture | range (s) | ql span | measures | expected vs DOM `hs-loop` |
|---|---|---|---|---|
| steady | 5.2–12.4 | 8–20 | 3–6 | 11 notes, **exact match** |
| warped | 5.3–13.9 | ~8–20 | 3–5 | exact match |

Half-open overlap `[start,end)` in ql space; the DOM mark set equals the
engine's `canonicalsInRange` exactly (asserted in the harness). A loop is
therefore visible both in transport time (green region) and as the marked
score passage, and `measuresInRange` feeds the statusbar readout.

### Loop drift (8 wraps, 1.5 s loop at 1.5×)

| Fixture | wrap overshoot (mean/max) | period error (mean/max) | cumulative drift |
|---|---|---|---|
| steady | 9.1 / 21.9 ms | +63.9 / +66.6 ms | +447.6 ms |
| warped | 15.0 / 28.6 ms | +64.0 / +66.6 ms | +448.2 ms |

**Known limitation, carried from UI-004 unchanged:** each wrap costs ~64 ms
of dead time — `MediaElement.currentTime` write stalls the pipeline (the
detected overshoot is only ~9–29 ms; the rest is seek-settle latency).
Identical magnitude to UI-004's measurement (64.5 ms) → backend property,
not a regression. The M2 decision stands: WebAudio `loopStart/loopEnd` for
sample-accurate looping vs pre-seek compensation vs accept.

### Concert ↔ F管 switch while playing

| Fixture | switch wall time | selection | clock consistency | playback | loop |
|---|---|---|---|---|---|
| steady | 87.6 ms | ✓ sn-000012 kept | 1.6 ms | ✓ continued | ✓ kept |
| warped | 59.2 ms | ✓ | 1.4 ms | ✓ | ✓ |

The switch re-renders Verovio (~60–90 ms) while the media clock keeps
running — post-switch audio time matches `before + elapsed` to ~1.5 ms.
Canonical selection (a tied note, the multi-fragment case) re-marks in the
new presentation; loop and selection region survive untouched.

## Acceptance criteria — status

- [x] authoritative transport implementation documented — §architecture; media clock + `TransportCore`/`MediaPort` boundary unchanged from UI-004
- [x] waveform click seeks score context — measured 1.1 ms median, 24/24 correct
- [x] score note click seeks audio — measured 3.8 ms median over all 40 notes
- [x] active score highlight follows playback — 0/361 mismatch frames, both warps
- [x] loop is represented in both time and score context — region + `hs-loop` marks + measure readout, exact-match verified
- [x] manual scrolling does not fight follow — navigation suspends; clicks/seeks do not
- [x] Resume Follow is explicit — `追従を再開` button only (checkbox re-arms too)
- [x] Concert/Horn switch preserves canonical selection and transport time — verified: 1.4–1.6 ms clock consistency, playback continued
- [x] playback continues correctly through view switch — verified
- [x] synchronization error measured on deterministic fixtures — 0 mismatched frames; 0 ms boundary lag (same-frame application)
- [x] loop drift measured — ~64 ms/wrap dead time, matches UI-004 finding
- [x] timing/mapping logic has UI-independent unit tests — 54 vitest cases
- [x] no full Verovio render at playback-frame frequency — **0** `renderToSVG` calls during playback (counter-instrumented)
- [x] no full React-tree update at playback-frame frequency — ~11 Hz renders vs 361 frames
- [x] measurements and known limits documented — this file + committed raw JSON

## Known issues / carried forward

1. **Loop gap ~64 ms/wrap** (MediaElement backend, identical to UI-004) —
   needs the M2 decision (WebAudio loop points vs pre-seek vs accept).
2. **Seconds-domain loop bounds carry ~1 ulp float noise at exact ql
   boundaries** — a loop edge that lands exactly on a note boundary may
   include the touching neighbour. Interior bounds are exact; documented
   with a dedicated test. Non-issue for user-dragged loops.
3. **Measurement browser is Chrome headless**, not WebView2 — numbers are
   engine-family approximations; re-run under Tauri before Gate D.
4. **View switch cost ~60–90 ms** is a full Verovio reload+re-render —
   acceptable at spike scale; a presentation cache could make it ~free.
5. **Single-part, single-voice fixtures only** — `<chord>`/`<backup>` are
   handled in `buildSyncMap` but not exercised by the committed fixture;
   multi-voice canonical spanning needs a dedicated fixture before M3.
6. **Tie-fragment highlighting marks all fragments** of an active tied note
   (sounding span semantics — the tie *is* still sounding). If UX wants
   only the currently-written fragment lit, the engine would need per-
   fragment ql windows — trivial to add, not required by the ticket.
