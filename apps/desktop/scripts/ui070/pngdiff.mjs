/**
 * Debug helper: pixel-diff two PNGs using a real browser canvas decode.
 *
 *   node scripts/ui070/pngdiff.mjs <golden.png> <candidate.png>
 *
 * Prints the differing-pixel count (summed RGB delta > 24) and bounding
 * box — use it to see whether a `ui070:matrix:check` DIFF is real layout
 * change or compositor noise.
 */
import { findBrowser, pixelDiffPng } from "./lib.mjs";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const [a, b] = process.argv.slice(2);
if (!a || !b || !existsSync(a) || !existsSync(b)) {
  console.error("usage: node scripts/ui070/pngdiff.mjs <a.png> <b.png>");
  process.exit(1);
}
const browser = await puppeteer.launch({
  executablePath: findBrowser(process.env.HS_BROWSER ?? "chrome"),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  console.log(JSON.stringify(await pixelDiffPng(page, a, b)));
} finally {
  await browser.close();
}
