/**
 * Optional browser E2E for the UI-003 spike — not wired into npm scripts/deps.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run preview   (serves the built dist/ on :4173)
 *   node scripts/e2e-playwright.mjs
 *
 * Verifies the DOM-level interactions in a real browser: SVG render, click ->
 * canonical id, class-only highlight, Concert<->Horn switch preserving
 * selection, time->element slider, error recovery, and 100/150/200% DPI smoke
 * via deviceScaleFactor. Writes screenshots to results/.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.SPIKE_RESULTS_DIR ?? join(here, '..', 'results');
mkdirSync(resultsDir, { recursive: true });

const BASE = process.env.SPIKE_URL ?? 'http://localhost:4173';
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();

async function newPage(dsf) {
  const ctx = await browser.newContext({ deviceScaleFactor: dsf, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return { ctx, page, errors };
}

// ---------- main flow @100% ----------
{
  const { ctx, page, errors } = await newPage(1);
  await page.goto(BASE);
  await page.waitForSelector('g.note#hs-sn-000001', { timeout: 30000 });
  check('golden concert renders (g.note#hs-sn-000001 present)', true);

  // click a notehead -> canonical id in the selection panel
  await page.click('g#hs-sn-000003-2 .notehead');
  const selText = await page.textContent('.hs-props');
  check('click tied fragment -> canonical sn-000003 shown', selText?.includes('sn-000003'), selText?.replace(/\s+/g, ' ').slice(0, 160));
  const cls = await page.getAttribute('g#hs-sn-000003', 'class');
  check('all tie fragments carry hs-selected class', (await page.$$eval('g.hs-selected', (els) => els.map((e) => e.id))).sort().join(',') === 'hs-sn-000003,hs-sn-000003-2,hs-sn-000003-3', cls);

  // element -> time moved the slider (fragment 2 onsets at m.2 = 2400ms @100bpm)
  const timeText = await page.textContent('.hs-timecode');
  check('element->time: slider moved to fragment onset (2.40s)', timeText?.includes('2.40'), timeText);

  // parallel listbox exists and mirrors selection
  const ariaSel = await page.$$eval('[role="option"][aria-selected="true"]', (els) => els.length);
  check('a11y listbox mirrors selection', ariaSel >= 1, `${ariaSel} selected option(s)`);

  // time -> element via slider: set to 2500ms
  await page.locator('.hs-time-field input').evaluate((el) => {
    el.value = '2500';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const active = (await page.$$eval('g.hs-active', (els) => els.map((e) => e.id))).sort();
  // canonical-level active highlight covers all fragments of sn-000003 —
  // the tied note sounds across the barline as one canonical note.
  check('time->element: 2.5s highlights canonical sn-000003 (all fragments)',
    active.join(',') === 'hs-sn-000003,hs-sn-000003-2,hs-sn-000003-3', active.join(','));

  // Concert -> Horn: selection preserved on the same canonical note
  await page.click('button:has-text("F管ホルン")');
  await page.waitForSelector('g.note#hs-sn-000001');
  const hornSel = (await page.$$eval('g.hs-selected', (els) => els.map((e) => e.id))).sort();
  check('Horn switch preserves canonical selection (all fragments)', hornSel.join(',') === 'hs-sn-000003,hs-sn-000003-2,hs-sn-000003-3', hornSel.join(','));
  await page.screenshot({ path: join(resultsDir, 'golden_horn_selected.png') });

  // zoom -> re-render, ids still present
  await page.locator('.hs-zoom input').evaluate((el) => {
    el.value = '150';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('g.note#hs-sn-000001');
  check('zoom 150% re-render keeps element ids + selection', (await page.$$('g.hs-selected')).length === 3);

  // multisystem fixture -> 2 pages
  await page.selectOption('select', 'multisystem');
  await page.waitForSelector('g.note#hs-sn-000001');
  const pageCount = await page.$$eval('.hs-score-page', (els) => els.length);
  check('multisystem renders 2 pages', pageCount === 2, `${pageCount}`);
  await page.screenshot({ path: join(resultsDir, 'multisystem.png'), fullPage: false });

  // error injection -> recoverable. Verovio logs the parse failure to console
  // and the app logs the caught error — expected noise, so count only errors
  // that happened before this step.
  const errorsBeforeInject = errors.length;
  await page.click(`button:has-text("エラー注入テスト")`);
  await page.waitForSelector('.hs-error-panel');
  check('corrupt input shows Japanese error state', (await page.textContent('.hs-error-panel'))?.includes('楽譜を表示できません'));
  await page.click(`.hs-error-panel button:has-text("再試行")`);
  await page.waitForSelector('g.note[id^="hs-sn-"]');
  check('再試行 recovers the score', true);

  check('no page/console errors during normal flow (pre-injection)',
    errorsBeforeInject === 0, errors.slice(0, 3).join(' | '));
  await page.screenshot({ path: join(resultsDir, 'main_flow.png') });
  await ctx.close();
}

// ---------- DPI smoke: 100% / 150% / 200% ----------
for (const dsf of [1, 1.5, 2]) {
  const { ctx, page, errors } = await newPage(dsf);
  await page.goto(BASE);
  await page.waitForSelector('g.note#hs-sn-000001', { timeout: 30000 });
  const box = await page.locator('g#hs-sn-000001').boundingBox();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  check(`DPI ${dsf * 100}%: renders + hit-target bounds exist (dpr=${dpr})`, !!box && box.width > 0);
  await page.click('g#hs-sn-000003-2 .notehead');
  check(`DPI ${dsf * 100}%: click resolves canonical`, (await page.textContent('.hs-props'))?.includes('sn-000003'));
  await page.screenshot({ path: join(resultsDir, `dpi_${dsf * 100}.png`) });
  check(`DPI ${dsf * 100}%: no errors`, errors.length === 0, errors.slice(0, 2).join('|'));
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
