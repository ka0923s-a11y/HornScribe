# UI-005 spike — score ⇔ audio sync

One authoritative media clock drives waveform playhead, canonical score
identity, and rendered Verovio notation. Sync runs through **time + canonical
IDs only** — never scroll position.

```text
audio seconds ──TimeWarp──▶ ql ──SyncMap──▶ canonical sn-* ──hs-*──▶ rendered <g>
     ▲                                                              │
     └──────────── TransportCore (MediaPort = HTMLMediaElement) ◀───┘ click→seek
```

- `src/transport/` — UI-004's TransportCore + wavesurfer adapter (media clock
  is authoritative; React gets ~10 Hz throttled snapshots).
- `src/sync/` — `rational.ts` (exact Fraction-equivalent), `timewarp.ts`
  (mirror of `python/hornscribe/rhythm/timewarp.py`/`beatmap.py`),
  `syncMap.ts` (MusicXML → exact ql spans; canonical-id grouping, rests,
  ties), `syncEngine.ts` (seconds ↔ canonical ↔ loop passage).
- `src/score/` — UI-003's Verovio wrapper + DOM highlight helpers
  (`hs-selected` / `hs-active` / `hs-loop` / measure wash = class toggles).
- `fixtures/` — committed generated MusicXML pair (concert + F管ホルン,
  40 canonical notes, 12 bars, ties, rests; `npm run gen:fixtures`).
- Audio is synthesized in-app through the warp (`src/audio/synth.ts`) —
  each canonical note's ql span → seconds → decaying sine + onset click.
- `src/measure/harness.ts` + `scripts/measure.mjs` — in-page measurement
  driven by puppeteer-core; raw JSON lands in `measurements/`.

## Run

```bash
npm install
npm run dev        # or: npm run build && npm run preview
npm run test       # vitest: warp/map/engine/transport unit tests
npm run typecheck
npm run gen:fixtures   # regenerate committed MusicXML (deterministic)
npm run measure        # production-build measurement → measurements/ui-005-*.json
```

Results doc: `docs/UI_005_SPIKE_RESULTS.md`.
