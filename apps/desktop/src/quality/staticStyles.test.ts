/**
 * @vitest-environment node
 *
 * UI-070 §6 focus-visible gate: the stylesheet contract that guarantees a
 * visible focus indicator on every keyboard-focusable element. jsdom/axe
 * cannot evaluate :focus-visible painting, so this gate verifies the
 * *rules that produce* the indicator:
 *
 * - a global :focus-visible outline using the --hs-focus-width /
 *   --hs-focus tokens;
 * - --hs-focus-width ≥ 2px (DESIGN_SYSTEM §16 "2px perimeter相当");
 * - no blanket `outline: none`/`outline: 0` on :focus or :focus-visible;
 * - a theme-scoped --hs-focus token exists for both light and dark.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTokenThemes } from "./contrast";

const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, "../styles.css"), "utf8");
const tokensCss = readFileSync(join(here, "../theme/tokens.css"), "utf8");
const themes = parseTokenThemes(tokensCss);

describe("focus-visible contract (§6/§16)", () => {
  it("a global :focus-visible rule paints the focus ring from tokens", () => {
    const rule = /:focus-visible\s*\{[^}]*outline:\s*var\(--hs-focus-width\)\s*solid\s*var\(--hs-focus\)/s;
    expect(styles).toMatch(rule);
  });

  it("--hs-focus-width is ≥ 2px", () => {
    const m = /--hs-focus-width:\s*(\d+(?:\.\d+)?)px/.exec(tokensCss);
    expect(m).not.toBeNull();
    expect(parseFloat(m![1])).toBeGreaterThanOrEqual(2);
  });

  it("--hs-focus is defined per theme", () => {
    expect(themes.light.get("--hs-focus")).toMatch(/^#/);
    expect(themes.dark.get("--hs-focus")).toMatch(/^#/);
    expect(themes.light.get("--hs-focus")).not.toBe(themes.dark.get("--hs-focus"));
  });

  it("no rule removes the outline from :focus-visible or bare :focus", () => {
    // `:focus:not(:focus-visible) { outline: none }` is the sanctioned
    // removal (keyboard-only ring); anything broader is a violation.
    const offenders = [
      ...styles.matchAll(
        /([^{}]+)\{[^}]*outline:\s*(?:none|0)(?:\s+solid)?[^}]*\}/g,
      ),
    ]
      .map((m) => m[1].trim())
      .filter(
        (sel) =>
          sel.includes(":focus") &&
          !sel.includes(":not(:focus-visible)") &&
          !sel.includes(":focus-visible"),
      );
    expect(offenders).toEqual([]);
    // And :focus-visible must never be an outline-removal selector
    // (excluding the sanctioned `:not(:focus-visible)` carve-out).
    const bad = [...styles.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)[^}]*\}/g)]
      .map((m) => m[1].replace(/:not\(:focus-visible\)/g, ""))
      .filter((sel) => sel.includes(":focus-visible"));
    expect(bad).toEqual([]);
  });
});
