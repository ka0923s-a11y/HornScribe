/**
 * UI-070 visual matrix + canonical golden screenshots.
 *
 *   node scripts/ui070/capture-matrix.mjs [--check] [--only=id,id]
 *
 * Two layers:
 * - GOLDEN: the canonical Japanese fixture set (docs/UX_VALIDATION.md §10)
 *   at 1920x1080@100 in light AND dark, committed under docs/ui-070/
 *   with a sha256 manifest (matrix-manifest.json). `--check` re-renders
 *   and compares pixels (canvas diff, small tolerance — Chromium
 *   rasterization is not bit-stable) — the visual-regression gate.
 * - MATRIX: every §27 screen state at every spec viewport
 *   (1366x768@100, 1920x1080@100, 1920x1080@150, 3840x2160@150, plus a
 *   1920x1080@200 scaling smoke) × light/dark — written to the gitignored
 *   apps/desktop/measurements/ui-070/ sweep directory.
 *
 * Every golden capture also runs the shared accessibility audit
 * (a11y-core.mjs) inside the page — real Chromium, real Verovio DOM —
 * and violations fail the run.
 *
 * Requires a Chrome/Edge binary (puppeteer-core). Dev server is spawned
 * automatically (#/dev/state/* routes are DEV-gated).
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  GOLDEN_DIR,
  OUT_DIR,
  chord,
  freezeForScreenshot,
  injectAudit,
  launchBrowser,
  newPage,
  pixelDiffPng,
  runAudit,
  settle,
  sha256,
  startViteDev,
  waitForScore,
  waitForServer,
  writeJson,
  outPath,
} from "./lib.mjs";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const NO_AUDIT = args.includes("--no-audit");
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");

/* ------------------------- fixture actions ------------------------- */

async function press(page, key) {
  if (key.includes("+")) await chord(page, key);
  else await page.keyboard.press(key);
  await settle(page, 120);
}

async function clickButtonWithText(page, text) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find(
      (el) =>
        !el.disabled &&
        (el.textContent?.includes(t) ||
          el.getAttribute("aria-label")?.includes(t)),
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, text);
  if (!ok) throw new Error(`no enabled button containing "${text}"`);
  await settle(page);
}

async function openReview(page) {
  await clickButtonWithText(page, "要確認");
  await page.waitForSelector(".hs-score-reviewbar", { timeout: 15000 });
}

async function selectFirstNote(page) {
  await page.waitForSelector('.hs-score-pages [id^="hs-"]', { timeout: 30000 });
  const ok = await page.evaluate(() => {
    const el = document.querySelector('.hs-score-pages g.note[id^="hs-"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const evt = new MouseEvent("click", {
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      bubbles: true,
    });
    el.dispatchEvent(evt);
    return true;
  });
  if (!ok) throw new Error("no note element found to select");
  await page.waitForSelector(".hs-score-pages .hs-selected", { timeout: 10000 });
}

async function openExport(page) {
  await press(page, "Control+E");
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
}

async function openSettings(page) {
  await clickButtonWithText(page, "設定");
  await page.waitForSelector('[data-hs-focus-zone="settings"]', {
    timeout: 15000,
  });
}

/** Golden fixtures = docs/UX_VALIDATION.md §10 canonical set. */
const GOLDENS = [
  { id: "empty", label: "空状態", hash: "#/dev/state/empty" },
  { id: "audio-ready", label: "音源読込", hash: "#/dev/state/audioReady" },
  { id: "transcribing", label: "採譜中", hash: "#/dev/state/transcribing" },
  { id: "audio-error", label: "音源エラー", hash: "#/dev/state/audioError" },
  { id: "source-missing", label: "音源移動", hash: "#/dev/state/sourceMissing" },
  { id: "transcription-error", label: "worker crash", hash: "#/dev/state/transcriptionError" },
  {
    id: "score-ready",
    label: "採譜完了",
    hash: "#/dev/state/scoreReady",
    after: waitForScore,
  },
  {
    id: "score-hornf",
    label: "F管表示",
    hash: "#/dev/state/scoreReady",
    after: async (page) => {
      await waitForScore(page);
      await press(page, "Control+2");
    },
  },
  {
    id: "score-selection",
    label: "音符選択",
    hash: "#/dev/state/scoreReady",
    after: async (page) => {
      await waitForScore(page);
      await selectFirstNote(page);
    },
  },
  {
    id: "reviewing",
    label: "要確認",
    hash: "#/dev/state/scoreReady",
    after: async (page) => {
      await waitForScore(page);
      await openReview(page);
    },
  },
  {
    id: "export-dialog",
    label: "書き出し",
    hash: "#/dev/state/scoreReady",
    after: async (page) => {
      await waitForScore(page);
      await openExport(page);
    },
  },
  {
    id: "export-musescore-missing",
    label: "MuseScore不足",
    hash: "#/dev/state/scoreReady",
    flags: { "hornscribe.dev.museScore": "missing" },
    after: async (page) => {
      await waitForScore(page);
      await openExport(page);
    },
  },
  {
    id: "settings",
    label: "設定",
    hash: "#/dev/state/audioReady",
    after: openSettings,
  },
  {
    id: "focus-visible",
    label: "focus-visible",
    hash: "#/dev/state/audioReady",
    after: async (page) => press(page, "F6"),
  },
];

const VIEWPORTS = [
  { id: "1366x768@100", width: 1366, height: 768, dsf: 1 },
  { id: "1920x1080@100", width: 1920, height: 1080, dsf: 1 },
  { id: "1920x1080@150", width: 1920, height: 1080, dsf: 1.5 },
  { id: "3840x2160@150", width: 3840, height: 2160, dsf: 1.5 },
  { id: "1920x1080@200", width: 1920, height: 1080, dsf: 2 },
];

/** The full matrix sweep = every §27 state at every viewport × theme. */
const MATRIX_STATES = [
  "empty",
  "openingAudio",
  "audioReady",
  "audioError",
  "sourceMissing",
  "transcribing",
  "transcriptionError",
  "scoreReady",
  "reviewing",
  "exporting",
];

async function gotoState(page, baseUrl, hash, flags) {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
  if (flags) {
    // Dev-fixture flags (hornscribe.dev.*) are read when the port is
    // constructed — reload so they take effect, localStorage survives.
    await page.evaluate((f) => {
      for (const [k, v] of Object.entries(f)) {
        try {
          window.localStorage.setItem(k, v);
        } catch {
          /* ignore */
        }
      }
    }, flags);
  }
  // Hash-only navigation keeps the React tree mounted (modal state like
  // the export dialog would leak between fixtures) — force a real reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  // .hs-shell is the app root — the settings view intentionally unmounts
  // the command bar, so don't wait on a specific zone.
  await page.waitForSelector(".hs-shell", { timeout: 30000 });
}

async function main() {
  const { proc, url } = startViteDev();
  const { browser, executablePath } = await launchBrowser();
  const manifestPath = join(GOLDEN_DIR, "matrix-manifest.json");
  const report = {
    tool: "ui-070-capture-matrix",
    timestamp: new Date().toISOString(),
    browser: executablePath,
    goldens: [],
    matrix: [],
    a11y: [],
  };
  let failures = 0;

  try {
    await waitForServer(url);
    console.log(`dev server: ${url}`);

    const goldens = only
      ? GOLDENS.filter((g) => only.includes(g.id))
      : GOLDENS;

    /* ---------- golden layer: canonical set @1920x1080 light+dark ---------- */
    const checkDir = join(OUT_DIR, "golden-check");
    if (CHECK) {
      rmSync(checkDir, { recursive: true, force: true });
      mkdirSync(checkDir, { recursive: true });
    }
    const targetDir = CHECK ? checkDir : GOLDEN_DIR;
    mkdirSync(targetDir, { recursive: true });

    for (const theme of ["light", "dark"]) {
      const page = await newPage(browser, {
        width: 1920,
        height: 1080,
        dsf: 1,
        theme,
      });
      // Pin the wall clock — the transcribing fixture renders a live
      // elapsed readout (500ms tick), which would otherwise make the
      // golden non-deterministic.
      await page.evaluateOnNewDocument(() => {
        const FIXED = 1_700_000_000_000;
        Date.now = () => FIXED;
      });
      for (const g of goldens) {
        await gotoState(page, url, g.hash, g.flags);
        await settle(page);
        if (g.after) await g.after(page);
        await settle(page, 250);
        await freezeForScreenshot(page);
        const file = `${g.id}-${theme}.png`;
        const buf = await page.screenshot({
          path: join(targetDir, file),
        });
        const hash = sha256(buf);
        const entry = { file, state: g.id, label: g.label, theme, viewport: "1920x1080@100", sha256: hash };
        report.goldens.push(entry);
        console.log(`golden ${file}  ${hash.slice(0, 12)}`);

        if (!NO_AUDIT) {
          await injectAudit(page);
          const a11y = await runAudit(page);
          report.a11y.push({ state: g.id, theme, ...a11y });
          if (a11y.violations.length > 0) {
            failures += 1;
            console.error(
              `  a11y violations in ${g.id}/${theme}:\n` +
                a11y.violations
                  .map((v) => `    [${v.rule}] ${v.target} — ${v.detail}`)
                  .join("\n"),
            );
          }
        }

        // Clear dev flags so the next fixture on this page is pristine —
        // they only take effect on reload, so clearing now is enough.
        if (g.flags) {
          await page.evaluate((f) => {
            for (const k of Object.keys(f)) window.localStorage.removeItem(k);
          }, g.flags);
        }
      }
      await page.close();
    }

    if (CHECK) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const expected = new Map(manifest.goldens.map((g) => [g.file, g.sha256]));
      // Chromium rasterization is not bit-stable between runs — a sha256
      // mismatch only fails when real pixels differ above the threshold.
      // MAX_DIFF_PIXELS tolerates a handful of noisy pixels; any genuine
      // layout/copy regression differs in far more.
      const MAX_DIFF_PIXELS = 100;
      const diffPage = await newPage(browser);
      let diffs = 0;
      for (const g of report.goldens) {
        const want = expected.get(g.file);
        if (want === g.sha256) continue;
        const d = await pixelDiffPng(
          diffPage,
          join(GOLDEN_DIR, g.file),
          join(targetDir, g.file),
        );
        if (d.diffs > MAX_DIFF_PIXELS) {
          diffs += 1;
          console.error(
            `DIFF ${g.file}: ${d.diffs} pixels differ (box ${JSON.stringify(d.box)})`,
          );
        } else {
          console.log(
            `  ${g.file}: sha differs but ${d.diffs} pixels above threshold — compositor noise, ok`,
          );
        }
      }
      await diffPage.close();
      console.log(diffs === 0 ? "golden check: no visual diffs" : `golden check: ${diffs} diffs`);
      report.goldenCheck = { diffs };
      failures += diffs;
    } else {
      writeJson(manifestPath, {
        generatedAt: report.timestamp,
        viewport: "1920x1080@100",
        themes: ["light", "dark"],
        goldens: report.goldens,
      });
      console.log(`wrote ${manifestPath}`);
    }

    /* ---------- matrix sweep (gitignored) ---------- */
    if (!CHECK) {
      for (const vp of VIEWPORTS) {
        for (const theme of ["light", "dark"]) {
          const page = await newPage(browser, {
            width: vp.width,
            height: vp.height,
            dsf: vp.dsf,
            theme,
          });
          for (const state of MATRIX_STATES) {
            await gotoState(page, url, `#/dev/state/${state}`);
            if (state === "scoreReady" || state === "reviewing" || state === "exporting") {
              try {
                await waitForScore(page, 60_000);
              } catch {
                /* score render timeout — capture anyway */
              }
            } else {
              await settle(page);
            }
            await freezeForScreenshot(page);
            const file = `${state}-${vp.id}-${theme}.png`;
            const p = outPath("matrix", file);
            mkdirSync(join(OUT_DIR, "matrix"), { recursive: true });
            await page.screenshot({ path: p });
            report.matrix.push({ file, state, viewport: vp.id, theme, sha256: sha256(readFileSync(p)) });
          }
          await page.close();
          console.log(`matrix ${vp.id}/${theme} done`);
        }
      }
    }

    writeJson(
      CHECK ? outPath("golden-check-report.json") : outPath("capture-report.json"),
      report,
    );
    console.log(`\nwrote report to ${OUT_DIR}`);
    if (failures > 0) {
      console.error(`FAILED: ${failures} violation(s)/diff(s)`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    proc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
