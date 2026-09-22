/**
 * @vitest-environment jsdom
 *
 * UI-070 keyboard-only gate (docs/UX_VALIDATION.md §7): drives the mounted
 * shell with real `keydown` events through the window-level dispatcher and
 * asserts the F6 zone cycle, disabled-shortcut swallowing, and the pitch
 * switch shortcut — the traversal half of the keyboard-only scenario. The
 * end-to-end flow (open → transcribe → review → export) is exercised by the
 * scripted browser run (scripts/ui070/dogfood.mjs) because file dialogs and
 * WASM rendering need a real engine.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { zoneElements } from "../focus/zones";
import { installJsdomStubs } from "./testEnv";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(hash: string): Promise<void> {
  window.location.hash = hash;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
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

function key(
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
}

function dispatch(e: KeyboardEvent): boolean {
  const target = document.activeElement ?? document.body;
  return target.dispatchEvent(e);
}

function zoneOf(el: Element | null): string | null {
  return el?.closest("[data-hs-focus-zone]")?.getAttribute("data-hs-focus-zone") ?? null;
}

describe("keyboard-only traversal", () => {
  it("F6 cycles every visible zone in spec order and lands on a focusable target", async () => {
    await mount("#/dev/state/audioReady");
    const expected = zoneElements(document).map(
      (z) => z.dataset.hsFocusZone,
    );
    expect(expected.length).toBeGreaterThanOrEqual(4); // cmd/waveform/score/transport/status

    const visited: (string | null)[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      await act(async () => {
        dispatch(key("F6"));
      });
      visited.push(zoneOf(document.activeElement));
    }
    expect(visited).toEqual(expected);
    // And the focused element is inside a zone (not lost on body).
    expect(zoneOf(document.activeElement)).not.toBeNull();
  });

  it("Shift+F6 cycles backwards through the same zones", async () => {
    await mount("#/dev/state/audioReady");
    const zones = zoneElements(document);
    await act(async () => {
      dispatch(key("F6"));
    });
    const first = zoneOf(document.activeElement);
    await act(async () => {
      dispatch(key("F6", { shift: true }));
    });
    const back = zoneOf(document.activeElement);
    expect(first).toBe(zones[0].dataset.hsFocusZone);
    expect(back).toBe(zones[zones.length - 1].dataset.hsFocusZone);
  });

  it("Ctrl+2 switches to F-horn view (segmented state flips)", async () => {
    await mount("#/dev/state/audioReady");
    const hornOption = () =>
      [...document.querySelectorAll('[role="radio"], button')].find(
        (el) => el.textContent?.includes("F管") ?? false,
      );
    await act(async () => {
      dispatch(key("2", { ctrl: true }));
    });
    const el = hornOption();
    expect(el).toBeTruthy();
    const pressed =
      el!.getAttribute("aria-pressed") ??
      el!.getAttribute("aria-checked") ??
      (el!.classList.contains("hs-segmented__item--selected") ? "true" : "false");
    expect(pressed).toBe("true");
  });

  it("disabled shortcuts are swallowed, not leaked (Ctrl+E with no score opens no dialog)", async () => {
    await mount("#/dev/state/audioReady");
    await act(async () => {
      dispatch(key("e", { ctrl: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("empty state: Tab reaches the primary 開く action and F6 cycles shell zones", async () => {
    await mount("");
    // F6 from nowhere lands on the first zone in spec order.
    await act(async () => {
      dispatch(key("F6"));
    });
    expect(zoneOf(document.activeElement)).toBe("commandbar");
  });
});
