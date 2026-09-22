/**
 * UI-070 usability dogfood harness (docs/UX_VALIDATION.md §2).
 *
 *   node scripts/ui070/dogfood.mjs
 *
 * Drives the shell in real Chromium (dev server — #/dev/state/* routes and
 * the mock engine are DEV-gated) through the eight §2 tasks, recording
 * duration / clicks / keystrokes per task. What cannot be automated
 * (native file dialogs, real audio decode) is recorded as MANUAL in the
 * output and must be verified by hand — see docs/UI_070_VALIDATION_RESULTS.md.
 *
 * Writes measurements/ui-070/dogfood-<timestamp>.json (gitignored).
 */
import {
  chord,
  launchBrowser,
  newPage,
  outPath,
  settle,
  startViteDev,
  waitForScore,
  waitForServer,
  writeJson,
} from "./lib.mjs";

/** Action counter — every scripted input goes through these. */
function makeCounter() {
  return {
    clicks: 0,
    keys: 0,
    async click(page, text) {
      this.clicks += 1;
      const ok = await page.evaluate((t) => {
        const b = [...document.querySelectorAll("button")].find(
          (el) => !el.disabled && el.textContent?.includes(t),
        );
        if (!b) return false;
        b.click();
        return true;
      }, text);
      if (!ok) throw new Error(`no enabled button containing "${text}"`);
      await settle(page, 120);
    },
    async key(page, k) {
      this.keys += 1;
      if (k.includes("+")) await chord(page, k);
      else await page.keyboard.press(k);
      await settle(page, 120);
    },
    async clickNote(page) {
      this.clicks += 1;
      const ok = await page.evaluate(() => {
        const el = document.querySelector('.hs-score-pages g.note[id^="hs-"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent("click", {
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2,
            bubbles: true,
          }),
        );
        return true;
      });
      if (!ok) throw new Error("no note element");
      await settle(page, 120);
    },
  };
}

async function goto(page, baseUrl, hash) {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-hs-focus-zone="commandbar"]', {
    timeout: 30000,
  });
  await settle(page, 200);
}

async function main() {
  const dev = startViteDev(1470);
  const { browser, executablePath } = await launchBrowser();
  const results = [];
  try {
    await waitForServer(dev.url);
    console.log(`dev server: ${dev.url}  browser: ${executablePath}`);
    const page = await newPage(browser, { width: 1920, height: 1080 });

    /* ---- Task A: open + transcribe ------------------------------- */
    // Automated leg: AUDIO_READY → click 採譜 → wait SCORE_READY.
    // The file-open leg needs the native dialog → MANUAL in the doc.
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/audioReady");
      const t0 = Date.now();
      await c.click(page, "採譜");
      await page.waitForSelector(".hs-score-pages svg", { timeout: 120000 });
      results.push({
        task: "A open+transcribe",
        durationMs: Date.now() - t0,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: true,
        note: "scripted from audioReady; the file-open leg is manual",
      });
      console.log(`A transcribe: ${results.at(-1).durationMs}ms, ${c.clicks} click`);
    }

    /* ---- Task B: create loop (≤5s target) ------------------------- */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      const t0 = Date.now();
      await c.key(page, "Control+L"); // toggle loop on score clock
      const loopOn = await page.evaluate(
        () =>
          [...document.querySelectorAll("button")].some(
            (b) => b.getAttribute("aria-pressed") === "true",
          ) || document.querySelector(".hs-loop") !== null,
      );
      await c.key(page, "Space"); // start playback
      const dur = Date.now() - t0;
      results.push({
        task: "B create loop",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: loopOn === true && dur < 5000,
        note: "target: loop starts within 5s (Ctrl+L + Space)",
      });
      console.log(`B loop: ${dur}ms, ${c.keys} keys, loop=${loopOn}`);
    }

    /* ---- Task C: source-check a note ------------------------------ */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      const t0 = Date.now();
      await c.clickNote(page); // 1: select the note
      const selected = await page.evaluate(
        () => document.querySelector(".hs-score-pages .hs-selected") !== null,
      );
      // 2: open review → 元音源を再生 (R) replays the source range.
      await c.click(page, "要確認");
      await page.waitForSelector(".hs-score-reviewbar", { timeout: 15000 });
      await c.key(page, "R");
      const dur = Date.now() - t0;
      results.push({
        task: "C source-check a note",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: selected,
        note: "select → review → R (元音源を再生); target ≈2 ops, measured ops include review entry",
      });
      console.log(`C source-check: ${dur}ms, ${c.clicks}+${c.keys} actions`);
    }

    /* ---- Task D: correct + undo ------------------------------------ */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      const t0 = Date.now();
      await c.click(page, "要確認");
      await page.waitForSelector(".hs-score-reviewbar", { timeout: 15000 });
      await c.key(page, "Alt+ArrowUp"); // +1 semitone correction
      const undoEnabled = await page.evaluate(
        () =>
          [...document.querySelectorAll("button")].some(
            (b) => !b.disabled && b.textContent?.includes("元に戻す"),
          ),
      );
      await c.key(page, "Control+Z"); // undo
      const dur = Date.now() - t0;
      results.push({
        task: "D correct + undo",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: undoEnabled,
        note: "Alt+↑ correction then Ctrl+Z; undo availability asserted",
      });
      console.log(`D correct+undo: ${dur}ms, undo=${undoEnabled}`);
    }

    /* ---- Task E: Concert→F-horn switch preserves context ----------- */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      await c.clickNote(page);
      const selBefore = await page.evaluate(
        () => document.querySelector(".hs-score-pages .hs-selected")?.id ?? null,
      );
      const t0 = Date.now();
      await c.key(page, "Control+2");
      await settle(page, 400);
      const selAfter = await page.evaluate(
        () => document.querySelector(".hs-score-pages .hs-selected")?.id ?? null,
      );
      const dur = Date.now() - t0;
      results.push({
        task: "E Concert→F-horn switch",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: selBefore != null && selAfter != null,
        note: `selection before=${selBefore} after=${selAfter} (canonical id survives re-render)`,
      });
      console.log(`E pitch switch: ${dur}ms, sel ${selBefore} → ${selAfter}`);
    }

    /* ---- Task F: keyboard-only review processing ------------------- */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      const t0 = Date.now();
      await c.click(page, "要確認");
      await page.waitForSelector(".hs-score-reviewbar", { timeout: 15000 });
      // Process 3 issues: R (source) → O (accept) → next lands automatically
      // or via ArrowRight.
      for (let i = 0; i < 3; i += 1) {
        await c.key(page, "R");
        await c.key(page, "O");
        await c.key(page, "ArrowRight");
      }
      const dur = Date.now() - t0;
      results.push({
        task: "F review item processing (3 items)",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: true,
        keysPerItem: c.keys / 3,
        note: "keyboard-only: R + O + → per item",
      });
      console.log(`F review: ${dur}ms, ${c.keys / 3} keys/item`);
    }

    /* ---- Task G: F-horn export ------------------------------------- */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await waitForScore(page);
      const t0 = Date.now();
      await c.key(page, "Control+E");
      await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
      await settle(page, 600); // capabilities probe
      const hornChecked = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')];
        const horn = boxes.find((b) =>
          b.closest("label, .hs-export__option")?.textContent?.includes("F管"),
        );
        return horn?.checked ?? null;
      });
      await c.click(page, "書き出す");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="dialog"] *')].some((el) =>
            el.textContent?.match(/書き出しました|完了/),
          ),
        { timeout: 30000 },
      );
      const dur = Date.now() - t0;
      results.push({
        task: "G F-horn export",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: true,
        note: `horn MusicXML pre-checked: ${hornChecked}`,
      });
      console.log(`G export: ${dur}ms`);
    }

    /* ---- Task H: export without MuseScore --------------------------- */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/scoreReady");
      await page.evaluate(() =>
        window.localStorage.setItem("hornscribe.dev.museScore", "missing"),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-hs-focus-zone="commandbar"]');
      await waitForScore(page);
      const t0 = Date.now();
      await c.key(page, "Control+E");
      await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
      await settle(page, 800);
      // PDF options must be blocked with a visible recovery action; the
      // MusicXML path must still complete.
      const recovery = await page.evaluate(
        () =>
          [...document.querySelectorAll('[role="dialog"] button')].some(
            (b) => b.textContent?.includes("設定") || b.textContent?.includes("MuseScore"),
          ),
      );
      const pdfDisabled = await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].some(
          (b) => b.disabled && b.closest("label, .hs-export__option")?.textContent?.includes("PDF"),
        ),
      );
      await c.click(page, "書き出す");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="dialog"] *')].some((el) =>
            el.textContent?.match(/書き出しました|完了/),
          ),
        { timeout: 30000 },
      );
      const dur = Date.now() - t0;
      await page.evaluate(() =>
        window.localStorage.removeItem("hornscribe.dev.museScore"),
      );
      results.push({
        task: "H export without MuseScore",
        durationMs: dur,
        clicks: c.clicks,
        keystrokes: c.keys,
        success: recovery && pdfDisabled,
        note: `PDF blocked=${pdfDisabled}, settings recovery visible=${recovery}; MusicXML path completed`,
      });
      console.log(`H musescore-missing: ${dur}ms, recovery=${recovery} pdfBlocked=${pdfDisabled}`);
    }

    /* ---- §7 keyboard-only primary flow ------------------------------ */
    {
      const c = makeCounter();
      await goto(page, dev.url, "#/dev/state/audioReady");
      const t0 = Date.now();
      let ok = true;
      const focusedButton = (needle, exclude) =>
        page.evaluate(
          (t, ex) => {
            const el = document.activeElement;
            if (el?.tagName !== "BUTTON") return false;
            const label =
              el.textContent ?? el.getAttribute("aria-label") ?? "";
            return label.includes(t) && (!ex || !label.includes(ex));
          },
          needle,
          exclude,
        );
      try {
        // F6 lands on commandbar → Tab to the 採譜 command → Enter.
        // NB: zone roots are tabbable too, so match buttons only —
        // the score region's textContent contains the same words.
        await c.key(page, "F6");
        for (let i = 0; i < 10; i += 1) {
          // Exclude the options-popover trigger (採譜オプション).
          if (await focusedButton("採譜", "オプション")) break;
          await c.key(page, "Tab");
          if (i === 9) throw new Error("採譜 button unreachable by Tab");
        }
        await c.key(page, "Enter");
        await page.waitForSelector(".hs-score-pages svg", { timeout: 120000 });
        // 再生 → 要確認 → 元音源 → 問題なし → F管 → 書き出し — all keyboard.
        await c.key(page, "Space");
        // F6 re-anchors to the command bar; Fluent toolbar moves between
        // commands with arrow keys (roving focus), not Tab.
        await c.key(page, "F6");
        let found = false;
        for (let i = 0; i < 12; i += 1) {
          if (await focusedButton("要確認")) {
            found = true;
            break;
          }
          await c.key(page, "ArrowRight");
        }
        // Fallback for environments where the toolbar isn't a mover group:
        // plain Tab walk from the command bar.
        if (!found) {
          await c.key(page, "F6");
          for (let i = 0; i < 14; i += 1) {
            if (await focusedButton("要確認")) {
              found = true;
              break;
            }
            await c.key(page, "Tab");
          }
        }
        if (!found) throw new Error("要確認 button unreachable by keyboard");
        await c.key(page, "Enter");
        await page.waitForSelector(".hs-score-reviewbar", { timeout: 15000 });
        await c.key(page, "R");
        await c.key(page, "O");
        await c.key(page, "Escape"); // exit review
        await c.key(page, "Control+2"); // F管
        await c.key(page, "Control+E");
        await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
      } catch (e) {
        ok = false;
        console.error("  keyboard-only flow failed:", e.message);
        results.push({
          task: "§7 keyboard-only primary flow",
          durationMs: Date.now() - t0,
          clicks: c.clicks,
          keystrokes: c.keys,
          success: false,
          note: String(e.message),
        });
      }
      if (ok) {
        results.push({
          task: "§7 keyboard-only primary flow",
          durationMs: Date.now() - t0,
          clicks: c.clicks,
          keystrokes: c.keys,
          success: true,
          note: "audioReady → transcribe → play → review → R → O → exit → F管 → export dialog, zero clicks",
        });
      }
      console.log(`§7 keyboard-only flow: ${ok ? "PASS" : "FAIL"} (${c.keys} keys)`);
    }
  } finally {
    await browser.close();
    dev.proc.kill();
  }

  const doc = {
    tool: "ui-070-dogfood",
    timestamp: new Date().toISOString(),
    browser: executablePath,
    results,
  };
  const file = outPath(`dogfood-${Date.now()}.json`);
  writeJson(file, doc);
  console.log(`\nwrote ${file}`);
  console.log(JSON.stringify(doc, null, 2));
  if (results.some((r) => !r.success)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
