/**
 * @vitest-environment jsdom
 *
 * Focus-zone cycling tests (GUI_UX_SPEC §22: F6 cycles major regions in the
 * Tab order コマンドバー → 波形 → 楽譜 → プロパティ → トランスポート → 状態領域).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  currentZone,
  cycleFocusZone,
  focusZone,
  zoneElements,
} from "./zones";

/**
 * Minimal shell mirroring AppShell's zone markup. In jsdom there is no
 * layout, so visibility is driven by the `hidden` attribute (the same
 * fallback path the module uses without checkVisibility).
 */
function buildShell(): void {
  document.body.innerHTML = `
    <div class="hs-shell">
      <div data-hs-focus-zone="commandbar">
        <button type="button" id="cmd-open">開く</button>
        <button type="button" id="cmd-transcribe">採譜</button>
      </div>
      <div data-hs-focus-zone="waveform" tabindex="0"></div>
      <div data-hs-focus-zone="score" tabindex="0">
        <button type="button" id="score-cta">採譜を開始</button>
      </div>
      <div data-hs-focus-zone="properties" tabindex="0"></div>
      <div data-hs-focus-zone="transport" tabindex="-1">
        <button type="button" id="transport-play">再生</button>
      </div>
      <div data-hs-focus-zone="status" tabindex="0"></div>
    </div>`;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("zoneElements", () => {
  it("lists zones in spec order regardless of DOM tweaks", () => {
    buildShell();
    expect(
      zoneElements(document).map((el) => el.dataset.hsFocusZone),
    ).toEqual([
      "commandbar",
      "waveform",
      "score",
      "properties",
      "transport",
      "status",
    ]);
  });

  it("skips hidden zones", () => {
    buildShell();
    document
      .querySelector('[data-hs-focus-zone="properties"]')!
      .setAttribute("hidden", "");
    expect(
      zoneElements(document).map((el) => el.dataset.hsFocusZone),
    ).not.toContain("properties");
  });
});

describe("focusZone", () => {
  it("focuses the first focusable element inside the zone", () => {
    buildShell();
    expect(focusZone("commandbar", document)).toBe(true);
    expect(document.activeElement?.id).toBe("cmd-open");
  });

  it("falls back to the zone root when it has no controls", () => {
    buildShell();
    expect(focusZone("waveform", document)).toBe(true);
    expect(
      (document.activeElement as HTMLElement).dataset.hsFocusZone,
    ).toBe("waveform");
  });

  it("returns false for an absent zone", () => {
    buildShell();
    expect(focusZone("nosuch", document)).toBe(false);
  });
});

describe("cycleFocusZone", () => {
  it("starts at the first zone when focus is outside all zones", () => {
    buildShell();
    (document.activeElement as HTMLElement)?.blur?.();
    expect(cycleFocusZone(1, document)).toBe("commandbar");
  });

  it("walks the spec order and lands on useful targets", () => {
    buildShell();
    cycleFocusZone(1, document); // → commandbar (first button)
    expect(document.activeElement?.id).toBe("cmd-open");
    expect(cycleFocusZone(1, document)).toBe("waveform");
    expect(cycleFocusZone(1, document)).toBe("score");
    expect(document.activeElement?.id).toBe("score-cta");
    expect(cycleFocusZone(1, document)).toBe("properties");
    expect(cycleFocusZone(1, document)).toBe("transport");
    expect(document.activeElement?.id).toBe("transport-play");
    expect(cycleFocusZone(1, document)).toBe("status");
    // Wraps around to the start.
    expect(cycleFocusZone(1, document)).toBe("commandbar");
  });

  it("Shift+F6 walks backwards", () => {
    buildShell();
    cycleFocusZone(1, document);
    cycleFocusZone(1, document); // at waveform
    expect(cycleFocusZone(-1, document)).toBe("commandbar");
    expect(cycleFocusZone(-1, document)).toBe("status"); // wraps
  });

  it("skips a hidden zone mid-cycle", () => {
    buildShell();
    document
      .querySelector('[data-hs-focus-zone="properties"]')!
      .setAttribute("hidden", "");
    cycleFocusZone(1, document);
    cycleFocusZone(1, document);
    cycleFocusZone(1, document); // → score
    expect(cycleFocusZone(1, document)).toBe("transport");
  });

  it("returns null when no zones exist", () => {
    document.body.innerHTML = "<p>empty</p>";
    expect(cycleFocusZone(1, document)).toBeNull();
  });
});

describe("currentZone", () => {
  it("reports the zone holding focus", () => {
    buildShell();
    const el = document.getElementById("score-cta")!;
    el.focus();
    expect(currentZone(document)?.dataset.hsFocusZone).toBe("score");
  });

  it("is null when focus is outside zones", () => {
    buildShell();
    (document.activeElement as HTMLElement)?.blur?.();
    expect(currentZone(document)).toBeNull();
  });
});
