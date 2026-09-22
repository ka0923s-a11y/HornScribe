/**
 * Shared harness for the UI-070 gates (visual matrix, perf, dogfood).
 *
 * Pattern follows apps/spikes/waveform/scripts/measure.mjs (UI-004):
 * vite dev/preview spawned directly via node so the child is killable,
 * real Chromium-family browser via puppeteer-core (Chrome preferred —
 * same engine family as the WebView2 runtime the Tauri shell targets).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(HERE, "..", "..");
export const OUT_DIR = join(APP_DIR, "measurements", "ui-070");
/** Committed golden screenshots + manifest (canonical Japanese fixtures). */
export const GOLDEN_DIR = join(APP_DIR, "..", "..", "docs", "ui-070");

const BROWSERS = {
  chrome: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  edge: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
};

export function findBrowser(preferred = "chrome") {
  const candidates = [
    ...(BROWSERS[preferred] ?? []),
    ...BROWSERS.chrome,
    ...BROWSERS.edge,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error("No Chrome/Edge executable found for puppeteer-core");
}

export async function waitForServer(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start: ${url}`);
}

/** Spawn `vite` (dev server) — needed because #/dev/state/* routes and the
 *  gallery are import.meta.env.DEV-gated. */
export function startViteDev(port = 1470) {
  const proc = spawn(
    process.execPath,
    [
      join(APP_DIR, "node_modules/vite/bin/vite.js"),
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: APP_DIR, stdio: "pipe" },
  );
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return { proc, url: `http://localhost:${port}` };
}

/** Spawn `vite preview` of the production build (dist/ must exist). */
export function startVitePreview(port = 1471) {
  const proc = spawn(
    process.execPath,
    [
      join(APP_DIR, "node_modules/vite/bin/vite.js"),
      "preview",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: APP_DIR, stdio: "pipe" },
  );
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return { proc, url: `http://localhost:${port}` };
}

export async function launchBrowser() {
  const executablePath = findBrowser(process.env.HS_BROWSER ?? "chrome");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 300_000,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--enable-precise-memory-info",
      "--mute-audio",
      "--disable-renderer-backgrounding",
      "--no-sandbox",
      "--force-device-scale-factor=1",
      `--user-data-dir=${process.env.TEMP ?? "."}/ui070-profile`,
    ],
  });
  return { browser, executablePath };
}

export async function newPage(browser, { width, height, dsf = 1, theme } = {}) {
  const page = await browser.newPage();
  if (theme) {
    // hornscribe.theme localStorage — see src/theme/useThemeMode.ts.
    await page.evaluateOnNewDocument((t) => {
      try {
        window.localStorage.setItem("hornscribe.theme", t);
      } catch {
        /* best effort */
      }
    }, theme);
  }
  await page.setViewport({
    width: width ?? 1920,
    height: height ?? 1080,
    deviceScaleFactor: dsf,
  });
  page.on("pageerror", (e) => console.error("  pageerror:", e.message));
  return page;
}

/** Wait for render settle: fonts + two animation frames + quiet period. */
export async function settle(page, quietMs = 150) {
  await page.evaluate(async () => {
    try {
      await document.fonts.ready;
    } catch {
      /* jsdom-less envs */
    }
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  await new Promise((r) => setTimeout(r, quietMs));
}

/**
 * Freeze animations, transitions and the text caret so that pixel-exact
 * screenshot hashing is deterministic (Fluent Spinner, pulsing review
 * badges, blinking carets otherwise produce hash diffs between runs).
 * Idempotent per document; must be re-applied after full page reloads.
 */
export async function freezeForScreenshot(page) {
  await page.evaluate(() => {
    if (document.getElementById("hs-shot-freeze")) return;
    const s = document.createElement("style");
    s.id = "hs-shot-freeze";
    s.textContent =
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
    document.head.appendChild(s);
  });
}

/** Wait until a selector exists (bounded). */
export async function waitFor(page, selector, timeout = 30_000) {
  return page.waitForSelector(selector, { timeout });
}

/** Wait for score SVG content (verovio render). */
export async function waitForScore(page, timeout = 90_000) {
  await page.waitForSelector(".hs-score-pages svg", { timeout });
  await settle(page, 300);
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Compare two PNG files pixel-by-pixel inside a real page (canvas decode —
 * headless Chromium rasterization introduces sub-threshold compositor noise,
 * so byte-exact sha256 comparison produces false diffs between runs).
 *
 * A pixel counts as "different" when the summed RGB channel delta exceeds
 * `threshold`. Returns { diffs, box } where box is the [minX,minY,maxX,maxY]
 * bounding box of differing pixels ([-1] fields when zero).
 */
export async function pixelDiffPng(page, pathA, pathB, threshold = 24) {
  const a = readFileSync(pathA).toString("base64");
  const b = readFileSync(pathB).toString("base64");
  return page.evaluate(
    async (ba, bb, thr) => {
      const load = (d) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => res(img);
          img.src = "data:image/png;base64," + d;
        });
      const [i1, i2] = await Promise.all([load(ba), load(bb)]);
      if (i1.width !== i2.width || i1.height !== i2.height) {
        return { diffs: Infinity, sizeMismatch: true };
      }
      const c1 = document.createElement("canvas");
      const c2 = document.createElement("canvas");
      c1.width = c2.width = i1.width;
      c1.height = c2.height = i1.height;
      const x1 = c1.getContext("2d");
      const x2 = c2.getContext("2d");
      x1.drawImage(i1, 0, 0);
      x2.drawImage(i2, 0, 0);
      const d1 = x1.getImageData(0, 0, c1.width, c1.height).data;
      const d2 = x2.getImageData(0, 0, c2.width, c2.height).data;
      let diffs = 0;
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let i = 0; i < d1.length; i += 4) {
        const d =
          Math.abs(d1[i] - d2[i]) +
          Math.abs(d1[i + 1] - d2[i + 1]) +
          Math.abs(d1[i + 2] - d2[i + 2]);
        if (d > thr) {
          diffs += 1;
          const p = i / 4;
          const x = p % c1.width;
          const y = Math.floor(p / c1.width);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return { diffs, box: [minX, minY, maxX, maxY] };
    },
    a,
    b,
    threshold,
  );
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function outPath(...parts) {
  mkdirSync(OUT_DIR, { recursive: true });
  return join(OUT_DIR, ...parts);
}

/**
 * Inject the shared a11y audit into the page. The mjs file uses an
 * `export` statement which can't be eval'd — rewrite it to a global
 * assignment so the function (self-contained by design) runs in-page.
 */
export async function injectAudit(page) {
  // Hash-route navigations don't reload the document — skip if already
  // injected; wrap in an IIFE so the top-level consts don't collide on
  // re-evaluation within the same context.
  if (await page.evaluate(() => typeof globalThis.__hsAudit === "function")) {
    return;
  }
  const src = readFileSync(join(HERE, "a11y-core.mjs"), "utf8");
  const injected = `(() => {\n${src.replace(
    "export function auditAccessibility(",
    "globalThis.__hsAudit = function auditAccessibility(",
  )}\n})()`;
  if (!injected.includes("__hsAudit")) {
    throw new Error("a11y-core.mjs rewrite failed — export shape changed?");
  }
  await page.evaluate(injected);
}

export async function runAudit(page) {
  return page.evaluate(() => globalThis.__hsAudit(document.body));
}

/**
 * Press a chord like "Control+E" or "Alt+ArrowUp": puppeteer's press()
 * takes a single key, so modifiers are held manually. Digit keys accept
 * both "2" and "Digit2" spellings.
 */
export async function chord(page, text) {
  const parts = text.split("+");
  const key = parts.pop();
  const mods = parts.map((m) => {
    const n = m.toLowerCase();
    if (n === "control" || n === "ctrl") return "Control";
    if (n === "shift") return "Shift";
    if (n === "alt") return "Alt";
    if (n === "meta" || n === "cmd") return "Meta";
    throw new Error(`unknown modifier ${m}`);
  });
  const keyName = /^Digit\d$/.test(key) || key.length === 1 ? key : key;
  for (const m of mods) await page.keyboard.down(m);
  try {
    await page.keyboard.press(keyName);
  } finally {
    for (const m of mods.reverse()) await page.keyboard.up(m);
  }
}
