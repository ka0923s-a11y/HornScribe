/**
 * @vitest-environment jsdom
 *
 * Focus restoration tests (issue UI-012: "dialog close restores opener
 * focus", "focus restoration tests exist").
 */

import { afterEach, describe, expect, it } from "vitest";
import { createFocusRestorer } from "./focusRestore";

function button(label = "opener"): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createFocusRestorer", () => {
  it("restores focus to the opener when focus stranded on <body>", () => {
    const opener = button();
    opener.focus();
    const restorer = createFocusRestorer(document);
    restorer.capture();

    // Dialog closed, focus dropped to body — the stranded case.
    (document.activeElement as HTMLElement).blur?.();
    expect(document.activeElement).toBe(document.body);

    expect(restorer.restore()).toBe(true);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("does not steal focus when the user moved somewhere real", () => {
    const opener = button();
    const other = button("other");
    opener.focus();
    const restorer = createFocusRestorer(document);
    restorer.capture();

    // User deliberately moved focus — restoration must not override it.
    other.focus();
    expect(restorer.restore()).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("returns false when the opener is gone from the DOM", () => {
    const opener = button();
    opener.focus();
    const restorer = createFocusRestorer(document);
    restorer.capture();
    opener.remove(); // opener unmounted while the surface was open
    (document.activeElement as HTMLElement | null)?.blur?.();

    expect(restorer.restore()).toBe(false);
  });

  it("force mode restores even when focus is elsewhere", () => {
    const opener = button();
    const other = button("other");
    opener.focus();
    const restorer = createFocusRestorer(document);
    restorer.capture();
    other.focus();

    expect(restorer.restore({ force: true })).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("capture ignores <body> — there is nothing meaningful to restore to", () => {
    const restorer = createFocusRestorer(document);
    restorer.capture();
    expect(restorer.captured).toBeNull();
    expect(restorer.restore()).toBe(false);
  });

  it("restore is idempotent after success", () => {
    const opener = button();
    opener.focus();
    const restorer = createFocusRestorer(document);
    restorer.capture();
    (document.activeElement as HTMLElement).blur?.();
    expect(restorer.restore()).toBe(true);
    expect(restorer.restore()).toBe(false); // already consumed
  });
});
