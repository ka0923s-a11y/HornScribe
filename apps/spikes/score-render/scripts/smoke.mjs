/**
 * UI-003 node smoke test — runs the real Verovio WASM toolkit in Node against
 * the committed ENG-001 fixtures and asserts the mappings the issue requires:
 *
 *   MusicXML note/@id  ->  rendered SVG element id        (verovio pass-through)
 *   rendered element   ->  canonical sn-* id              (ids.ts, same file the app uses)
 *   canonical id       ->  all rendered fragments          (hs-sn-*-k tie splits)
 *   element            ->  onset time                      (getTimeForElement)
 *   time               ->  elements                        (getElementsAtTime)
 *   element            ->  page                            (getPageWithElement)
 *   reload / Concert↔Horn -> identical canonical mapping   (stability)
 *   corrupt input      ->  recoverable on same toolkit     (failure recovery)
 *
 * DOM assertions use jsdom against the actual SVG string. Run: `npm run smoke`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
// Node 24 strips types for .ts imports — this is the *same* module the app uses.
import {
  canonicalNoteIdFromMusicxml,
  isMusicxmlNoteId,
  isMusicxmlRestId,
} from '../src/lib/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const spikeRoot = join(here, '..');

const FIXTURES = {
  golden_concert: join(repoRoot, 'fixtures/musicxml/golden_v1_concert.musicxml'),
  golden_horn: join(repoRoot, 'fixtures/musicxml/golden_v1_horn_in_f.musicxml'),
  minimal_concert: join(repoRoot, 'fixtures/musicxml/minimal_v1_concert.musicxml'),
  minimal_horn: join(repoRoot, 'fixtures/musicxml/minimal_v1_horn_in_f.musicxml'),
  multisystem: join(spikeRoot, 'fixtures/multisystem_concert.musicxml'),
};

const OPTS = { pageWidth: 2100, pageHeight: 1100, scale: 40, adjustPageHeight: false, footer: 'none' };

let failures = 0;
const results = { measurements: {}, checks: [] };

function check(name, cond, detail = '') {
  results.checks.push({ name, pass: !!cond, detail });
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function timed(label, fn) {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  (results.measurements[label] ??= []).push(ms);
  return out;
}

const noteIds = (xml) => [...xml.matchAll(/<note id="([^"]+)"/g)].map((m) => m[1]);
const svgIds = (svg) => new Set([...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

console.log('== UI-003 smoke: Verovio WASM x ENG-001 fixtures ==\n');

// --- 1. toolkit init ---------------------------------------------------------
const tInit = performance.now();
const module_ = await createVerovioModule();
const tk = new VerovioToolkit(module_);
results.measurements.wasmInit = [performance.now() - tInit];
tk.setOptions(OPTS);
console.log(`toolkit ready (verovio ${tk.getVersion()})`);

// --- 2. per-fixture render + id pass-through ---------------------------------
const rendered = {};
for (const [name, path] of Object.entries(FIXTURES)) {
  const xml = readFileSync(path, 'utf8');
  const ok = timed(`loadData:${name}`, () => tk.loadData(xml));
  // loadData returns 1/0, not a boolean — and (see below) may return 1 for
  // truncated-but-parseable XML, so content checks must complement it.
  check(`${name}: loadData accepted`, !!ok);
  const firstSvg = timed(`renderToSVG(p1):${name}`, () => tk.renderToSVG(1));
  const pages = tk.getPageCount();
  const pagesSvg = [firstSvg];
  for (let p = 2; p <= pages; p++) pagesSvg.push(timed(`renderToSVG(p${p}):${name}`, () => tk.renderToSVG(p)));
  const allSvg = pagesSvg.join('\n');
  const ids = svgIds(allSvg);
  const expected = noteIds(xml);
  const missing = expected.filter((id) => !ids.has(id));
  check(`${name}: every MusicXML note/@id rendered into SVG`, missing.length === 0,
    `${expected.length} ids, missing=${missing.length}${missing.length ? ' ' + missing.join(',') : ''}`);
  rendered[name] = { xml, svg: allSvg, pages };
  console.log(`       ${name}: ${pages} page(s), ${expected.length} note elements`);
}

// --- 3. canonical id resolution (same code path as the app) ------------------
check('hs-sn-000003-2 -> sn-000003', canonicalNoteIdFromMusicxml('hs-sn-000003-2') === 'sn-000003');
check('hs-sn-000003   -> sn-000003', canonicalNoteIdFromMusicxml('hs-sn-000003') === 'sn-000003');
check('hs-rest-000001 -> null (no canonical)', canonicalNoteIdFromMusicxml('hs-rest-000001') === null);
check('isMusicxmlNoteId accepts fragments', isMusicxmlNoteId('hs-sn-000003-12') === true);
check('isMusicxmlRestId detects rests', isMusicxmlRestId('hs-rest-000002') === true);

// --- 4. DOM hit-test on real SVG (jsdom) -------------------------------------
{
  const dom = new JSDOM(rendered.golden_concert.svg, { contentType: 'image/svg+xml' });
  const doc = dom.window.document;
  const frag = doc.getElementById('hs-sn-000003-2');
  check('jsdom: getElementById finds tied fragment', frag !== null);
  check('fragment is a <g class="note">', frag?.getAttribute('class') === 'note');
  const noteEl = frag?.closest('g.note') ?? null;
  check('closest(g.note) hit-test resolves group', noteEl?.id === 'hs-sn-000003-2');
  check('DOM element -> canonical sn-000003', canonicalNoteIdFromMusicxml(noteEl?.id ?? '') === 'sn-000003');
  // all 3 fragments of sn-000003 render as separate elements sharing canonical id
  const frags = ['hs-sn-000003', 'hs-sn-000003-2', 'hs-sn-000003-3'].map((id) => doc.getElementById(id));
  check('all 3 tie fragments present as distinct elements', frags.every(Boolean));
  check('fragments share canonical id', new Set(frags.map((f) => canonicalNoteIdFromMusicxml(f.id))).size === 1);
  // highlight class toggle on the real elements — the no-re-render update path
  const t = performance.now();
  for (let i = 0; i < 1000; i++) for (const f of frags) f.classList.toggle('hs-selected', i % 2 === 0);
  results.measurements.highlightToggle1000 = [performance.now() - t];
  frags.forEach((f) => f.classList.add('hs-selected'));
  check('classList highlight applies to SVG elements', frags.every((f) => f.classList.contains('hs-selected')));
}

// --- 5. time <-> element mapping ----------------------------------------------
{
  tk.loadData(rendered.golden_concert.xml);
  timed('renderToTimemap:golden', () => tk.renderToTimemap());
  const t1 = timed('getTimeForElement:hs-sn-000001', () => tk.getTimeForElement('hs-sn-000001'));
  const t3 = tk.getTimeForElement('hs-sn-000003');
  const t3f2 = tk.getTimeForElement('hs-sn-000003-2');
  const t3f3 = tk.getTimeForElement('hs-sn-000003-3');
  check('element -> time: onsets are ordered', t1 === 0 && t3 === 1500 && t3f2 === 2400 && t3f3 === 3600,
    `0/1500/2400/3600 ms @100bpm got ${[t1, t3, t3f2, t3f3].join('/')}`);
  const at = timed('getElementsAtTime:2500', () => tk.getElementsAtTime(2500));
  check('time -> elements: 2.5s hits tied fragment hs-sn-000003-2',
    Array.isArray(at?.notes) && at.notes.includes('hs-sn-000003-2'), JSON.stringify(at?.notes));
  check('time -> elements resolves canonical', canonicalNoteIdFromMusicxml(at?.notes?.[0] ?? '') === 'sn-000003');
  // Finding: getElementsAtTime never reports MusicXML rests in `rests[]` —
  // rests carry no canonical identity in HornScribe anyway, so only the field's
  // presence and the absence of hs-rest-* from `notes` are asserted.
  const atRest = tk.getElementsAtTime(5000); // m.3: hs-rest-000002 spans this time
  check('rests field exists; no hs-rest-* surfaces in notes[]',
    Array.isArray(atRest?.rests) && !(atRest?.notes ?? []).some((n) => isMusicxmlRestId(n)),
    JSON.stringify(atRest));
  check('element -> page', tk.getPageWithElement('hs-sn-000004') === 1);
  const multi = rendered.multisystem;
  tk.loadData(multi.xml);
  check('multisystem fixture paginates (>1 page)', tk.getPageCount() > 1, `pages=${tk.getPageCount()}`);
  check('element -> page across pages', tk.getPageWithElement('hs-sn-000104') === tk.getPageCount());
}

// --- 6. stability across reload + Concert<->Horn ------------------------------
{
  const tk2 = new VerovioToolkit(module_);
  tk2.setOptions(OPTS);
  tk2.loadData(rendered.golden_concert.xml);
  const ids2 = svgIds(tk2.renderToSVG(1));
  check('fresh toolkit instance reproduces identical element ids',
    ['hs-sn-000001', 'hs-sn-000003', 'hs-sn-000003-2', 'hs-sn-000003-3', 'hs-rest-000001']
      .every((id) => ids2.has(id)));

  tk.loadData(rendered.golden_horn.xml);
  const hornIds = svgIds(tk.renderToSVG(1));
  const canonicalInHorn = [...hornIds].filter((i) => i.startsWith('hs-sn-')).map(canonicalNoteIdFromMusicxml);
  check('Horn presentation keeps identical export ids',
    ['hs-sn-000001', 'hs-sn-000002', 'hs-sn-000003', 'hs-sn-000003-2', 'hs-sn-000003-3', 'hs-sn-000004']
      .every((id) => hornIds.has(id)));
  check('Horn presentation resolves identical canonical ids',
    JSON.stringify(canonicalInHorn) === JSON.stringify(['sn-000001', 'sn-000002', 'sn-000003', 'sn-000003', 'sn-000003', 'sn-000004']),
    canonicalInHorn.join(','));
}

// --- 6b. ScoreRenderer wrapper (the same module the app uses) ------------------
{
  const { ScoreRenderer } = await import('../src/lib/verovio.ts');
  const r = new ScoreRenderer();
  await r.init();
  r.setZoom(100);
  check('wrapper: load golden', !!r.load(readFileSync(FIXTURES.golden_concert, 'utf8')));
  check('wrapper: renderAllPages returns pages', r.renderAllPages().length >= 1);
  const tm = r.timemap();
  check('wrapper: timemap parses (array)', Array.isArray(tm) && tm.length > 0, `${tm.length} entries`);
  check('wrapper: durationMs = 7200 (golden @100bpm, 12 quarters)', r.durationMs() === 7200, `${r.durationMs()}`);
  check('wrapper: timeForElement fragment', r.timeForElement('hs-sn-000003-2') === 2400);
  check('wrapper: elementsAtTime', r.elementsAtTime(2500)?.notes?.includes('hs-sn-000003-2'));
  check('wrapper: pageWithElement', r.pageWithElement('hs-sn-000004') === 1);
}

// --- 7. failure recovery -------------------------------------------------------
{
  const okBad = tk.loadData('not xml at all');
  check('non-XML input rejected (loadData falsy, no throw)', !okBad);
  // Caveat for the real app: truncated-but-well-formed XML returns 1 yet
  // renders an empty score — the UI must also verify content, not just `ok`.
  const okTrunc = tk.loadData('<score-partwise version="4.0"><part><measure>');
  const truncHasNotes = okTrunc ? /class="note"/.test(tk.renderToSVG(1)) : false;
  check('truncated XML: loadData=1 but zero notes (needs content check)',
    okTrunc === 1 && !truncHasNotes);
  const okGood = tk.loadData(rendered.golden_concert.xml);
  check('same toolkit instance recovers and renders again',
    !!okGood && tk.renderToSVG(1).includes('hs-sn-000001'));
}

// --- 8. zoom-level render timing (50/100/150/200% -> scale 20/40/60/80) --------
{
  const xml = readFileSync(FIXTURES.multisystem, 'utf8');
  for (const scale of [20, 40, 60, 80]) {
    tk.setOptions({ ...OPTS, scale });
    tk.loadData(xml);
    timed(`renderAllPages:multisystem:scale${scale}`, () => {
      const p1 = tk.renderToSVG(1);
      for (let p = 2; p <= tk.getPageCount(); p++) tk.renderToSVG(p);
      return p1;
    });
  }
  // repeated load+render of the golden pair (switch cost)
  for (let i = 0; i < 5; i++) {
    timed('loadData:golden_concert:warm', () => tk.loadData(readFileSync(FIXTURES.golden_concert, 'utf8')));
    timed('renderToSVG(p1):golden:warm', () => tk.renderToSVG(1));
    timed('loadData:golden_horn:warm', () => tk.loadData(readFileSync(FIXTURES.golden_horn, 'utf8')));
    timed('renderToSVG(p1):horn:warm', () => tk.renderToSVG(1));
  }
}

// --- summary -------------------------------------------------------------------
console.log('\n== measurements (ms) ==');
for (const [k, v] of Object.entries(results.measurements)) {
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`  ${k.padEnd(38)} n=${v.length} last=${v[v.length - 1].toFixed(2)} avg=${avg.toFixed(2)}`);
}
const passed = results.checks.filter((c) => c.pass).length;
console.log(`\n== ${passed}/${results.checks.length} checks passed${failures ? `, ${failures} FAILED` : ''} ==`);
process.exit(failures ? 1 : 0);
