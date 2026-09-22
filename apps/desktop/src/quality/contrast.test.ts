/**
 * @vitest-environment node
 *
 * UI-070 §6 contrast gate: computes WCAG 2.x ratios straight from
 * tokens.css for every catalogued semantic pair, in both themes.
 * Standard text must be ≥4.5:1; non-text interactive cues ≥3:1.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditContrast,
  contrastRatio,
  parseColor,
  parseTokenThemes,
  type ContrastResult,
} from "./contrast";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(
  join(here, "../theme/tokens.css"),
  "utf8",
);

const themes = parseTokenThemes(tokensCss);

function report(results: ContrastResult[]): string {
  return results
    .map(
      (r) =>
        `${r.pass ? "PASS" : "FAIL"} ${r.theme} ${r.pair.fg} on ${r.pair.bg}` +
        ` (${r.fg} → ${r.fgEffective} on ${r.bg}) = ${r.ratio}:1` +
        ` (needs ${r.required}:1)${r.pair.note ? ` — ${r.pair.note}` : ""}`,
    )
    .join("\n");
}

describe("token contrast (WCAG)", () => {
  it("parses both theme blocks", () => {
    expect(themes.light.get("--hs-surface-app")).toBeTruthy();
    expect(themes.dark.get("--hs-surface-app")).toBeTruthy();
  });

  it.each(["light", "dark"] as const)(
    "%s theme: every catalogued pair meets its WCAG threshold",
    (theme) => {
      const results = auditContrast(theme, themes[theme]);
      const failures = results.filter((r) => !r.pass);
      // Print the full table on failure for the run log.
      expect(failures, `\n${report(results)}`).toEqual([]);
    },
  );

  it.each(["light", "dark"] as const)(
    "%s theme: disabled text documented (WCAG exempt — Fluent palette value)",
    (theme) => {
      const tokens = themes[theme];
      const fg = parseColor(tokens.get("--hs-text-disabled") ?? "");
      const bg = parseColor(tokens.get("--hs-surface-app") ?? "");
      expect(fg && bg).toBeTruthy();
      // WCAG 2.x exempts disabled controls from contrast minimums; the
      // token follows the Fluent neutral palette. Recorded, not gated.
      const ratio = contrastRatio(fg!.rgb, bg!.rgb);
      expect(ratio).toBeGreaterThan(1);
    },
  );
});
