/**
 * UI-070 performance gate (docs/UX_VALIDATION.md §5).
 *
 *   node scripts/ui070/measure.mjs [--no-build]
 *
 * Two phases:
 * - production build (vite preview): bundle sizes + cold-shell-interactive.
 * - dev server (required for #/dev/state/* routes): score render, view
 *   switch, note select, seek latency, playback-highlight cadence,
 *   renderToSVG count on the frame path, JS heap. Dev-mode numbers are an
 *   UPPER BOUND — recorded as such.
 *
 * Writes measurements/ui-070/perf-<timestamp>.json (gitignored) and prints
 * the same JSON. Numbers feed docs/UI_070_VALIDATION_RESULTS.md.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import {
  APP_DIR,
  launchBrowser,
  newPage,
  outPath,
  settle,
  startViteDev,
  startVitePreview,
  waitForServer,
  waitForScore,
  writeJson,
} from "./lib.mjs";

const NO_BUILD = process.argv.includes("--no-build");

function bundleSizes() {
  const dist = join(APP_DIR, "dist", "assets");
  const files = readdirSync(dist).filter((f) => /\.(js|css)$/.test(f));
  const entries = files.map((f) => {
    const buf = readFileSync(join(dist, f));
    return {
      file: f,
      bytes: buf.length,
      gzipBytes: gzipSync(buf).length,
    };
  });
  const total = (k) => entries.reduce((s, e) => s + e[k], 0);
  return { files: entries, totalBytes: total("bytes"), totalGzipBytes: total("gzipBytes") };
}

async function measureColdInteractive(page, baseUrl) {
  const t0 = Date.now();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const interactiveMs = await page.evaluate(async () => {
    const t0 = performance.now();
    while (!document.querySelector('[data-hs-focus-zone="commandbar"] button')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return performance.now() - t0;
  });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n
      ? {
          domContentLoadedMs: Math.round(n.domContentLoadedEventEnd),
          loadEventMs: Math.round(n.loadEventEnd),
          responseMs: Math.round(n.responseEnd),
        }
      : null;
  });
  return { wallMs: Date.now() - t0, interactiveMs: Math.round(interactiveMs), nav };
}

async function measureScoreRender(page, baseUrl) {
  const t0 = Date.now();
  await page.goto(`${baseUrl}/#/dev/state/scoreReady`, {
    waitUntil: "domcontentloaded",
  });
  const renderMs = await page.evaluate(async () => {
    const t0 = performance.now();
    while (!document.querySelector(".hs-score-pages svg")) {
      await new Promise((r) => setTimeout(r, 15));
      if (performance.now() - t0 > 90000) return -1;
    }
    return performance.now() - t0;
  });
  const svgBytes = await page.evaluate(
    () => document.querySelector(".hs-score-pages")?.innerHTML.length ?? 0,
  );
  const notes = await page.evaluate(
    () => document.querySelectorAll('.hs-score-pages [id^="hs-"]').length,
  );
  return { wallMs: Date.now() - t0, renderMs: Math.round(renderMs), svgBytes, scoreElements: notes };
}

async function measureViewSwitch(page) {
  await page.evaluate(() => {
    window.__hsSwitchT0 = 0;
  });
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    const btn = [...document.querySelectorAll("button")].find(
      (b) =>
        b.textContent?.includes("設定") ||
        b.getAttribute("aria-label")?.includes("設定"),
    );
    btn?.click();
    while (!document.querySelector('[data-hs-focus-zone="settings"]')) {
      await new Promise((r) => setTimeout(r, 5));
      if (performance.now() - t0 > 10000) return -1;
    }
    return performance.now() - t0;
  });
  return Math.round(ms);
}

async function measureNoteSelect(page) {
  const ms = await page.evaluate(async () => {
    const el = document.querySelector('.hs-score-pages g.note[id^="hs-"]');
    if (!el) return -1;
    const t0 = performance.now();
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("click", {
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
      }),
    );
    while (!document.querySelector(".hs-score-pages .hs-selected")) {
      await new Promise((r) => setTimeout(r, 2));
      if (performance.now() - t0 > 10000) return -1;
    }
    return performance.now() - t0;
  });
  return Math.round(ms);
}

async function measureSeek(page) {
  // Arm a mutation observer on the transport clock BEFORE pressing End.
  const pending = page.evaluate(() => {
    return new Promise((resolve) => {
      const clock = document.querySelector(".hs-transport__time");
      const t0 = performance.now();
      const mo = new MutationObserver(() => {
        mo.disconnect();
        resolve(performance.now() - t0);
      });
      mo.observe(clock ?? document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      setTimeout(() => resolve(-1), 8000);
    });
  });
  await page.keyboard.press("End");
  return Math.round(await pending);
}

async function measurePlayback(page, seconds = 4) {
  // renderStats is exposed by verovio.ts in dev builds (UI-070 hook).
  const before = await page.evaluate(
    () => window.__hsRenderStats?.renderToSVGCalls ?? null,
  );
  const result = await page.evaluate(async (secs) => {
    const score = document.querySelector(".hs-score-pages");
    const marks = [];
    const t0 = performance.now();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (
          m.type === "attributes" &&
          m.attributeName === "class" &&
          m.target.classList?.contains("hs-active")
        ) {
          marks.push(performance.now() - t0);
        }
      }
    });
    if (score) {
      mo.observe(score, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
    await new Promise((r) => setTimeout(r, secs * 1000));
    mo.disconnect();
    const heap = performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576)
      : null;
    return {
      highlightUpdates: marks.length,
      firstMarkMs: marks.length ? Math.round(marks[0]) : null,
      intervals: marks.slice(1).map((t, i) => Math.round(t - marks[i])),
      heapMB: heap,
    };
  }, seconds);
  const after = await page.evaluate(
    () => window.__hsRenderStats?.renderToSVGCalls ?? null,
  );
  return {
    ...result,
    renderToSVGCallsDuringPlayback:
      before != null && after != null ? after - before : null,
  };
}

async function main() {
  const dist = join(APP_DIR, "dist", "index.html");
  if (!NO_BUILD || !existsSync(dist)) {
    console.log("building production bundle…");
    const b = spawn(process.execPath, [join(APP_DIR, "node_modules/vite/bin/vite.js"), "build"], {
      cwd: APP_DIR,
      stdio: "inherit",
    });
    await new Promise((res, rej) =>
      b.on("exit", (c) => (c === 0 ? res() : rej(new Error(`build exit ${c}`)))),
    );
  }

  const report = {
    tool: "ui-070-measure",
    timestamp: new Date().toISOString(),
    bundle: bundleSizes(),
  };

  /* ---- Phase A: production bundle, cold interactive ---- */
  const preview = startVitePreview();
  try {
    await waitForServer(preview.url);
    const { browser } = await launchBrowser();
    try {
      const page = await newPage(browser, { width: 1920, height: 1080 });
      report.coldInteractive = await measureColdInteractive(page, preview.url);
      console.log("cold interactive:", report.coldInteractive);
      report.heapProdMB = await page.evaluate(() =>
        performance.memory
          ? Math.round(performance.memory.usedJSHeapSize / 1048576)
          : null,
      );
      await page.close();
    } finally {
      await browser.close();
    }
  } finally {
    preview.proc.kill();
  }

  /* ---- Phase B: dev server, state-dependent measurements ---- */
  const dev = startViteDev(1470);
  try {
    await waitForServer(dev.url);
    const { browser } = await launchBrowser();
    try {
      const page = await newPage(browser, { width: 1920, height: 1080 });

      report.scoreRender = await measureScoreRender(page, dev.url);
      console.log("score render:", report.scoreRender);

      // Back to audioReady for view-switch / heap baseline.
      await page.goto(`${dev.url}/#/dev/state/audioReady`, {
        waitUntil: "domcontentloaded",
      });
      await settle(page, 400);
      report.viewSwitchMs = await measureViewSwitch(page);
      console.log("view switch:", report.viewSwitchMs, "ms");
      // Back to workspace.
      await page.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent?.includes("戻る"))
          ?.click();
      });
      await settle(page);

      // Score-dependent measurements.
      await page.goto(`${dev.url}/#/dev/state/scoreReady`, {
        waitUntil: "domcontentloaded",
      });
      await waitForScore(page);

      report.noteSelectMs = await measureNoteSelect(page);
      console.log("note select:", report.noteSelectMs, "ms");

      report.seekMs = await measureSeek(page);
      console.log("seek latency:", report.seekMs, "ms");

      await page.keyboard.press("Space");
      report.playback = await measurePlayback(page, 4);
      console.log("playback:", JSON.stringify(report.playback));
      await page.keyboard.press("Space");
    } finally {
      await browser.close();
    }
  } finally {
    dev.proc.kill();
  }

  const file = outPath(`perf-${Date.now()}.json`);
  writeJson(file, report);
  console.log(`\nwrote ${file}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
