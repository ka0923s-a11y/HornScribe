# UI-004 spike — waveform, loop, zoom, playback

Standalone Vite + React + TypeScript app validating wavesurfer.js 7.x behind a
HornScribe-owned `TransportController`. Frontend only — no Tauri needed for
these measurements (see `docs/UI_004_SPIKE_RESULTS.md` for the asset-protocol
mapping plan and all measured numbers).

## Layout

```text
src/
  transport/
    types.ts               TransportController contract (MASTER_PLAN §10 shape)
    core.ts                TransportCore — headless state machine (unit-tested)
    wavesurferAdapter.ts   wavesurfer.js adapter implementing the contract
    fakeMediaPort.ts       deterministic MediaPort for tests
    core.test.ts           vitest state-machine tests (seek/loop edges)
  audio/
    synth.ts               deterministic PCM fixture synthesis (== Python gen)
    wav.ts                 PCM16 mono WAV encoder
  measure/harness.ts       in-page measurement harness (window.__ui004)
  copy.ts                  canonical protocol/copy/ja-JP.json lookup + spike-local JA copy
scripts/
  generate_audio_fixtures.py  stdlib-only WAV generator (30s/3min/10min)
  measure.mjs                puppeteer-core driver: real-browser measurements
```

## Commands

```bash
npm install
npm run dev        # dev server
npm run build      # production build → dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest (TransportCore state machine)
npm run fixtures   # generate all WAV fixtures (python3, stdlib only)
npm run measure    # build must exist; drives Chrome/Edge headless, writes measurements/*.json
```

## Fixtures

- `public/fixtures/sweep_30s.wav` — committed (2.6 MB, PCM16 mono 44.1 kHz).
- `sweep_3min.wav` / `sweep_10min.wav` — gitignored; regenerate with
  `npm run fixtures` (~1 min). The app can also synthesize them in-browser
  (same formula as the Python generator) when the files are absent, so the
  spike works without them — file-based load is preferred for measurement.

## Notes

- All UI strings resolve from `protocol/copy/ja-JP.json`; spike-only labels
  live in `src/copy.ts` (`spikeCopy`) and are still Japanese-only.
- The playhead/time readout reads `getCurrentTime()` via rAF into a DOM node;
  React state receives throttled snapshots only (no per-frame rerenders).
- `dragToSeek` is intentionally off — it starves the Regions drag-select
  stream via `preventDefault` (documented in the results doc).
