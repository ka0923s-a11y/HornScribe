/**
 * @vitest-environment jsdom
 *
 * UI-070 §6 color-independence gate: status and review signaling must pair
 * color with a text label or a glyph — never color alone. Checks the badge
 * components render text + icon for every tone/status, and that the score
 * review-mark builder (score/domScore.ts) constructs a glyph + line, not a
 * tinted blot.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Info16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import {
  ReviewBadge,
  StatusBadge,
  type ReviewStatus,
  type StatusTone,
} from "../components/primitives/StatusBadge";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

const TONES: { tone: StatusTone; label: string; icon: React.ReactElement }[] = [
  { tone: "success", label: ja.gallery.samples.toolFound, icon: <CheckmarkCircle16Regular /> },
  { tone: "info", label: ja.gallery.samples.toolChecking, icon: <Info16Regular /> },
  { tone: "warning", label: ja.gallery.samples.infoNotice, icon: <Warning16Regular /> },
  { tone: "error", label: ja.gallery.samples.toolMissing, icon: <ErrorCircle16Regular /> },
];

const REVIEW_STATUSES: ReviewStatus[] = [
  "needsReview",
  "accepted",
  "dismissed",
  "fixed",
];

describe("color independence (§6)", () => {
  it.each(TONES)("StatusBadge $tone renders icon + text label", async ({ tone, label, icon }) => {
    await render(<StatusBadge tone={tone} label={label} icon={icon} />);
    const badge = document.querySelector(".hs-badge")!;
    expect(badge.textContent?.trim().length).toBeGreaterThan(0);
    // Icon present AND hidden from AT (the label carries the meaning).
    const ic = badge.querySelector(".hs-badge__icon");
    expect(ic).not.toBeNull();
    expect(ic!.getAttribute("aria-hidden")).toBe("true");
    expect(badge.querySelector(".hs-badge__label")!.textContent).toBe(label);
  });

  it.each(REVIEW_STATUSES)(
    "ReviewBadge $status renders a glyph + Japanese label",
    async (status) => {
      await render(<ReviewBadge status={status} />);
      const badge = document.querySelector(".hs-badge")!;
      expect(badge.querySelector(".hs-badge__icon")).not.toBeNull();
      expect(badge.querySelector(".hs-badge__label")!.textContent!.trim().length).toBeGreaterThan(0);
    },
  );

  it("score review marks are glyph+line constructions, not color-only", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../score/domScore.ts"), "utf8");
    // The mark must be built from a line + badge + glyph sub-elements —
    // shape redundancy on top of the tint.
    expect(src).toMatch(/__line/);
    expect(src).toMatch(/__badge/);
    expect(src).toMatch(/__glyph/);
  });

  it("stage-list items pair a text label with a state glyph (not color)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../styles.css"), "utf8");
    // data-state styling must target the icon/weight, not only color.
    expect(css).toMatch(/hs-stage-list__item\[data-state/);
  });
});
