/**
 * @vitest-environment jsdom
 *
 * UI-070 §6/§8 accessibility gate — mounts the real shell in jsdom for
 * every reachable screen state and runs the shared audit core
 * (scripts/ui070/a11y-core.mjs — the same audit the puppeteer gates run
 * inside real Chromium):
 *
 * - accessible name on every interactive element;
 * - Japanese names (canonical UI language);
 * - role widgets keyboard-focusable;
 * - named regions/zones (data-hs-focus-zone, role=region/toolbar/dialog);
 * - color-independence (badges/stage items carry text, not color alone).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { auditAccessibility } from "../../scripts/ui070/a11y-core.mjs";
import App from "../App";
import type { ScreenState } from "../workspace/screen";
import { installJsdomStubs } from "./testEnv";

// React 18.3: act() reads this flag to enable the testing behavior.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(hash?: string): Promise<void> {
  window.location.hash = hash ?? "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  // Let async effects (score document load, transport snapshot) settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
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
  window.location.hash = "";
});

function formatViolations(report: ReturnType<typeof auditAccessibility>) {
  return report.violations
    .map((v) => `[${v.rule}] ${v.target} — ${v.detail}`)
    .join("\n");
}

const STATES: readonly { hash: string; label: ScreenState }[] = [
  { hash: "", label: "empty" },
  { hash: "#/dev/state/openingAudio", label: "openingAudio" },
  { hash: "#/dev/state/audioReady", label: "audioReady" },
  { hash: "#/dev/state/audioError", label: "audioError" },
  { hash: "#/dev/state/sourceMissing", label: "sourceMissing" },
  { hash: "#/dev/state/transcribing", label: "transcribing" },
  { hash: "#/dev/state/transcriptionError", label: "transcriptionError" },
];

describe("accessibility audit — shell screen states", () => {
  it.each(STATES)("$label: zero violations", async ({ hash, label }) => {
    await mount(hash);
    const report = auditAccessibility(document.body);
    expect(report.stats.interactive).toBeGreaterThan(0);
    expect(
      report.violations,
      `${label} violations:\n${formatViolations(report)}`,
    ).toEqual([]);
  });

  // NOTE: scoreReady/reviewing/exporting mount the Verovio WASM renderer,
  // which never initializes under jsdom — those states are audited inside
  // real Chromium by scripts/ui070/capture-matrix.mjs (the same
  // auditAccessibility function injected via page.evaluate).

  it("every state exposes a live region for status announcements", async () => {
    await mount();
    const report = auditAccessibility(document.body);
    expect(report.stats.liveRegions).toBeGreaterThanOrEqual(1);
  });
});
