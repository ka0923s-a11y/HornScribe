# UI-003 — Verovio interactive score rendering spike: results

> Status: spike executed, evidence recorded.
> Issue: [#3 UI-003](https://github.com/bolph71656-ai/HornScribe/issues/3)
> App: `apps/spikes/score-render/` (Vite + React + TypeScript + `verovio@6.3.0` WASM)
> Verification: `npm run smoke` (42/42 checks, Node 24 + jsdom) and
> `scripts/e2e-playwright.mjs` (Playwright Chromium, all checks pass).
> Measured on the dev machine (Windows 11, Node v24.19.0, Chromium via Playwright).

## Verdict

**Pass.** Verovio WASM satisfies every required interaction, and the central
question — *does the MusicXML `note/@id` survive into the rendered SVG so a
rendered element maps back to a canonical `sn-*` id?* — is answered **yes**:
Verovio 6.3.0 mirrors `note/@id` verbatim onto the rendered group element
(`<g class="note" id="hs-sn-000003-2">`), including tie fragments and
`hs-rest-*` rests. No blocker found, so no OpenSheetMusicDisplay comparison was
required (see §7).

## 1. What renders (all verified in-browser and via smoke test)

| Fixture | Content | Result |
|---|---|---|
| `golden_v1_concert` | 3 bars, C major, F♯/B♭ accidentals, dotted rhythms, **B♭ tied across barline** (3 fragments `hs-sn-000003`, `-2`, `-3`), rests | 1 page, 8/8 note ids in SVG |
| `golden_v1_horn_in_f` | same music in written pitch (F管: key sig F♯, `transpose` diatonic −4 / chromatic −7, F♮ accidental) | 1 page, 8/8 ids — **same `hs-sn-*` ids as concert** |
| `minimal_v1_concert` / `minimal_v1_horn_in_f` | 1 bar each | render, ids intact |
| `multisystem_concert` (spike-generated, `scripts/gen-multisystem.mjs`, 24 bars, D major key sig, G♯/B♭ accidentals, two cross-barline ties, whole-measure rest) | multi-system + multi-page | 2 pages (3+2 systems), 111/111 ids |

Every `note/@id` from every fixture is present as a rendered element id —
asserted programmatically (`smoke.mjs` §2).

## 2. Canonical ID mapping — the core question

Rendered structure (verified):

```xml
<g id="hs-sn-000003-2" class="note">
  <g class="notehead"><use xlink:href="#E0A3-…"/></g>
  …stem/ledger lines…
</g>
<g id="hs-rest-000001" class="rest">…</g>
```

- `hs-sn-*` ids (incl. `-k` fragments) and `hs-rest-*` land **verbatim** on the
  `<g class="note">` / `<g class="rest">` groups. MusicXML 4.0 `note/@id` →
  Verovio element id is a pass-through.
- Non-`hs-*` elements get **random** Verovio ids (`yqx3gt5`, `bgiz57t`…) that
  change every load — never stable. HornScribe must only ever key off `hs-*`
  ids (consistent with CONTRACTS: presentation ids are derived/rebuildable).
- Resolution path: click → `e.target.closest('[id^="hs-"]')` → export id →
  `canonicalNoteIdFromMusicxml()` (`src/lib/ids.ts`, mirror of `ids.py`) →
  `sn-*`. `hs-sn-000003-2` → `sn-000003`; all 3 tie fragments resolve to the
  same canonical note (asserted in DOM and jsdom).
- **Reload stability**: a fresh toolkit instance reproduces identical `hs-*`
  element ids (smoke §6). Concert↔Horn switch keeps identical export ids →
  identical canonical ids (`sn-000001..sn-000004` in both presentations).
- Browser E2E: click on a hollow half-notehead → selection panel shows
  `正準ID sn-000003` / `MusicXML ID hs-sn-000003-2` / `開始時刻 2400 ms`.

## 3. Interaction findings

### Hit-testing needs an explicit hit area (real finding)

A hollow notehead (half/whole note) is **transparent at its centre** — clicks
there fall through to the `<svg>` background; `elementFromPoint` returns the
svg root. Painted-glyph hit-testing alone is unreliable. Fix implemented:
`buildElementIndex` appends an invisible `<ellipse class="hs-hit"
pointer-events="all">` over each notehead bbox inside the id-bearing group —
cheap, no re-render, survives `closest()` resolution. Production note: a
full-note or per-column hit strategy may want overlap resolution between
adjacent notes; the notehead ellipse is sufficient for the spike.

### Highlight = DOM class toggle, zero re-render (measured)

`.hs-selected` / `.hs-active` classes toggle `fill`/`stroke` on the group's
descendants. 1000 toggle iterations over 3 elements in jsdom ≈ **30 ms total
(~0.01 ms/op)**; in-browser the metrics panel reports the same order
(sub-millisecond). No `renderToSVG` call on the highlight path. The full
rendered-element index (`Map<canonicalId, Element[]>`) is rebuilt once per
page render and reapplies selection/active marks — also how selection survives
zoom re-renders and Concert↔Horn switches.

### Time ↔ element mapping (timemap)

| Direction | API | Result |
|---|---|---|
| element → time | `getTimeForElement('hs-sn-000003-2')` | `2400` ms — exact (m.2 @100 BPM) |
| element → time range | `getTimesForElement` | `{tstampOn, tstampOff, qfrac…}` — works |
| time → elements | `getElementsAtTime(2500)` | `{notes:['hs-sn-000003-2'], page:1, measure:…}` — exact |
| element → page | `getPageWithElement('hs-sn-000104')` | `2` on the multi-page fixture |
| full map | `renderToTimemap()` | `[{on:[ids], off:[ids], qstamp, tstamp, tempo}]` — drives the time slider |

- The app's time slider → `getElementsAtTime` → canonical set → `hs-active`
  highlight covers **all fragments** of a tied note — the tied note "sounds"
  as one canonical note across the barline (correct semantics).
- **Caveat:** `rests[]` in `getElementsAtTime` is always empty for MusicXML
  input — rests are not timemap entries. Harmless for HornScribe (rests carry
  no canonical identity) but noted for completeness.
- **Caveat:** `renderToTimemap()` in the ESM wrapper returns an
  already-`JSON.parse`d array, not a string — wrapper must not parse again
  (`verovio.ts` accepts both).
- Tempo comes from `<sound tempo="…">`; fixtures carry explicit tempos
  (100/120 BPM). Score without tempo would fall back to Verovio's default —
  the engine should always emit one.

### Failure recovery

- `loadData('not xml')` → returns `0`, no throw; same toolkit instance then
  loads + renders a valid score fine → **recoverable**, demonstrated in-app via
  「エラー注入テスト」→ `errors.scoreRenderFailed` copy (楽譜を表示できません +
  再試行) → 再試行 restores the score.
- **Caveat (important for production):** `loadData` returns `1` for
  *truncated-but-parseable* XML (`<score-partwise><part><measure>`) and
  silently renders an empty score. The UI must verify content (e.g. parsed
  note count > 0), not just the return value — implemented as such in the app.

### Zoom / resize

- Zoom slider 25–200% maps to Verovio `scale` (40 = 100%) → full re-layout +
  re-render (~18–25 ms for the 24-bar/111-note fixture, all pages). Selection
  and active marks reapply automatically from canonical ids.
- Pagination is stable across `scale` (Verovio scales page size with content);
  `pageHeight: 1100` used to force 2-page output for the multi-system demo.
- Resize is fluid: outer page svg is `max-width:100%; height:auto` (vector,
  no rasterisation).
- **Caveat:** CSS must target only the *outer* svg
  (`.hs-score-page > svg`). Verovio nests a `svg.definition-scale` that
  carries all content via `viewBox`; blanket `svg {}` rules restyle it and
  corrupt hit geometry (this was observed and fixed).

### Concert ↔ Horn switch

Segmented control (コンサートピッチ / F管ホルン, Ctrl+1/Ctrl+2, copy from
`segments.scoreView`). On switch: `loadData` + re-render (~30 ms load + ~7 ms
render warm for the golden pair), then the same `sn-*` selection and
time-based `hs-active` marks reapply to the new DOM and the selected fragment
scrolls into view. Verified in Chromium: all 3 fragments of `sn-000003` stay
selected in the Horn presentation.

## 4. Measurements

Node (real WASM module), `npm run smoke` output; n=1 cold / n=5 warm where noted.
These are small fixtures — see "gaps" for the extrapolation caveat.

| Operation | Result |
|---|---|
| WASM module init (`createVerovioModule` + toolkit) | ~240 ms one-time |
| `loadData` golden concert — first call | ~126 ms (first-use JIT/first layout) |
| `loadData` warm (golden concert / horn) | ~26 / ~29 ms avg |
| `loadData` multisystem (24 bars) | ~72 ms |
| `renderToSVG` golden p1 — cold / warm | ~16 ms / ~7 ms |
| `renderToSVG` multisystem p1 / p2 | ~21 / ~5 ms |
| `renderToSVG` multisystem all pages ×4 zooms (scale 20/40/60/80) | 18–25 ms each |
| `renderToTimemap` golden | ~43 ms |
| `getTimeForElement` | ~0.3 ms |
| `getElementsAtTime` | ~0.6 ms |
| highlight class toggle (DOM-only update path) | ~0.01 ms/element (jsdom); sub-ms in-browser per metrics panel |
| Concert↔Horn switch (loadData + all-page render) | ~35 ms warm |

Budget check vs GUI_UX_PLAN §46 (initial render ≤ 300 ms, local rerender
≤ 150–250 ms): fixtures pass comfortably. **Honest caveat:** fixtures are
1–24 bars; a real 3–5 minute single-part score (~500–1500 notes) should be
re-measured with a production-sized export before locking — extrapolation
suggests ~200–300 ms for ~10× content, inside budget, but unverified.

Bundle size: `dist` JS = **8.4 MB (2.46 MB gzip)** — the WASM is embedded in
`verovio-module.mjs` as an encoded binary string. One bundle, no `.wasm` asset
fetch, no CDN — fully offline.

## 5. DPI / 100% / 150% / 200%

- Playwright `deviceScaleFactor` 1 / 1.5 / 2: render + click → canonical +
  zero errors at each level (screenshots: `results/dpi_100.png`,
  `dpi_150.png`, `dpi_200.png`).
- SVG output is vector → HiDPI crispness is inherent; `window.devicePixelRatio`
  is surfaced in the metrics panel. Windows OS scaling is handled by the
  WebView/browser compositor; no raster assets exist.
- Zoom render timing measured at scale 20–80 (§4).

## 6. Accessibility strategy (does not depend on raw SVG)

- The rendered SVG block is `aria-hidden="true"` — decorative only.
- A parallel **`role="listbox"` note list** (`NoteList`) is built from the
  MusicXML itself (`parseScoreDoc`): every note/rest with 小節番号・音高・音価・
  export id; `aria-selected` mirrors the score selection; active playback notes
  get a `▶` marker + `is-active` style. Arrow keys navigate (roving tabindex),
  Enter/Space selects — the keyboard/screen-reader path exercises the same
  `canonicalNoteIdFromMusicxml` resolution as pointer input.
- Japanese accessible names throughout (`copy.score.regionAria`,
  `a11y.viewSwitcher`, etc.); all user-visible text is Japanese per §41
  (proper nouns/identifiers like Verovio, MusicXML, `sn-000003` excepted).

## 7. OpenSheetMusicDisplay fallback assessment

Not needed — no blocker. Verovio delivered stable identity, hit-testing (with
the hit-shape pattern), timemap both directions, pagination, and recovery.
Trigger conditions for a bounded OSMD comparison remain: (a) `note/@id`
pass-through breaks in a future Verovio version, (b) timemap gaps (e.g.
rests, multi-voice) become product-relevant, (c) WASM size/init cost proves
unacceptable. OSMD is MIT-licensed (easier than LGPL) but its element→id
mapping requires its own `cursor`/graphic-id plumbing — roughly equivalent
work, so only revisit on a concrete failure.

## 8. License / attribution — Verovio is LGPL-3.0-or-later

`verovio` npm package is `LGPL-3.0-or-later` (rism-digital/verovio). Implications
for HornScribe:

- Used **unmodified** as a bundled WASM/JS module via its public toolkit API —
  the LGPL "works that use the library" posture. We do not patch Verovio.
- Obligations to honour: keep copyright/license notices, provide attribution
  (Verovio already prints `Engraved by Verovio …` into every SVG `<desc>`),
  include the LGPL-3.0 text + link to upstream source in an About/NOTICE file
  in the shipped app, and do not impose restrictions that prevent a user
  replacing the library.
- LGPL does not extend to HornScribe's own code merely by API use/bundling;
  distribution stays fine for a personal/OSS app. If we ever *modify* Verovio
  itself, modifications must be offered under LGPL.
- Action for production: add a THIRD-PARTY-NOTICES entry (Verovio LGPL-3.0,
  https://github.com/rism-digital/verovio) in the app About/diagnostics.

## 9. Asset-loading implications for the Tauri shell (UI-001)

- Verovio's npm WASM build embeds the binary inside `verovio-module.mjs` — the
  frontend needs **no `.wasm` file fetch and no Tauri asset-protocol scope**
  for the renderer itself. The whole score path ships inside the JS bundle.
- `WebAssembly.compile/instantiate` under a strict CSP requires
  `wasm-unsafe-eval` in `script-src` — GUI_UX_PLAN §8.4 already anticipates
  this ("only if required" — it is required for Verovio WASM).
- MusicXML arrives as a **string** via IPC (`loadData`), matching this spike's
  `?raw`-bundled path — no file-URL loading needed in the webview.
- WebView2 (Chromium) is the same engine family as the verified Playwright
  run; no WebView2-specific divergence expected, to be confirmed in UI-001.
- `node:module` import inside `verovio-module.mjs` is a Node-only code path
  guarded by `ENVIRONMENT_IS_NODE`; Vite externalizes it harmlessly (build
  warning only).

## 10. Acceptance criteria — honest checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | runs fully offline; no CDN | ✅ | WASM inlined in bundle; `vite preview` + browser E2E pass with zero network |
| 2 | representative MusicXML renders correctly | ✅ | golden/minimal/multisystem all render; 8/8, 8/8, 2/2, 2/2, 111/111 note ids in SVG |
| 3 | Horn written pitch renders correctly | ✅ | `golden_v1_horn_in_f`: F管 key sig + transpose + F♮ render; same `hs-sn-*` ids |
| 4 | stable canonical mapping survives renderer reload | ✅ | fresh toolkit instance → identical `hs-*` element ids (smoke §6); reload+switch verified in browser |
| 5 | selection/highlight via DOM/CSS, no full rerender | ✅ | `classList` toggle only; measured ~0.01 ms/element |
| 6 | active-note update path measured/profiled | ✅ | smoke §4 metrics + live metrics panel; getElementsAtTime ~0.6 ms |
| 7 | 100/150/200% DPI smoke tests pass | ✅ | Playwright deviceScaleFactor 1/1.5/2 — all pass |
| 8 | renderer failure is recoverable | ✅ | error injection → Japanese error state → 再試行 recovers; same toolkit instance reloads OK. Caveat: truncated-XML acceptance requires content check (§3) |
| 9 | license/attribution documented | ✅ | §8 — LGPL-3.0-or-later, notices + About entry planned |
| 10 | a11y strategy does not depend on raw SVG alone | ✅ | parallel `listbox` from MusicXML model; SVG `aria-hidden`; keyboard nav + `aria-selected` mirror |

## 11. Known gaps / follow-ups for the production score view (UI-030)

- **Chords untested** — no `<note><chord/>` in fixtures; verify id placement
  on chord members before relying on per-note hit-testing in chords.
- **Multi-voice / multi-staff** untested (fixtures are single-voice single-part).
- **Rests absent from timemap** — confirmed harmless for canonical mapping.
- **Verovio random ids unstable** — only `hs-*` ids are contracts; add a
  regression guard (this smoke test) to CI before upgrading `verovio`.
- **Production-sized render** (3–5 min score) should be re-measured.
- Hit areas currently cover notehead + ~35% padding; overlapping/adjacent-note
  resolution and full-note-column targets are a UI-030 decision.
- `getElementsAtTime` granularity is onset-exact; playback highlighting at
  60 fps should throttle lookups (timemap is array-scan-friendly — precompute
  onset→canonical table in production rather than per-frame WASM calls).
