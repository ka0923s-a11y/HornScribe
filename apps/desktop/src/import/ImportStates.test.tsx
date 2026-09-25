/**
 * @vitest-environment jsdom
 *
 * #364 recent-projects UX: per-entry 履歴から削除 on the EMPTY list,
 * duplicate-name parent-dir sublines, and the projectOpenFailed card's
 * remove-and-close action. Exercises the real components through
 * ImportScreenBody with a fixture ImportView.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportScreenBody, type ImportView } from "./ImportStates";
import { DEFAULT_TRANSCRIPTION_OPTIONS } from "./types";
import { ja } from "../strings/ja";
import type { ScreenState } from "../workspace/screen";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const NOOP = () => undefined;

function view(overrides: Partial<ImportView>): ImportView {
  return {
    audio: null,
    openingLabel: null,
    openingKind: null,
    issue: null,
    sourceMissing: null,
    recentProjects: [],
    options: DEFAULT_TRANSCRIPTION_OPTIONS,
    onOpenAudio: NOOP,
    onOpenProject: NOOP,
    onRemoveRecent: NOOP,
    onPickRelink: NOOP,
    onDismissError: NOOP,
    onOptionsChange: NOOP,
    ...overrides,
  };
}

async function render(screen: ScreenState, v: ImportView): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ImportScreenBody screen={screen} view={v} onTranscribe={NOOP} />);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
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

describe("EMPTY recents (#364)", () => {
  it("each row offers a keyboard-focusable 履歴から削除 button", async () => {
    const removed: string[] = [];
    await render(
      "empty",
      view({
        recentProjects: [
          { name: "etude", path: "C:\\a\\etude.hornscribe.json", openedAt: 2 },
          { name: "solo", path: "C:\\b\\solo.hornscribe.json", openedAt: 1 },
        ],
        onRemoveRecent: (p) => removed.push(p),
      }),
    );
    const removeButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(".hs-recent__remove"),
    ];
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0].getAttribute("aria-label")).toBe(
      ja.import.recent.removeAria("etude"),
    );
    await click(removeButtons[0]);
    expect(removed).toEqual(["C:\\a\\etude.hornscribe.json"]);
  });

  it("duplicate names get a parent-dir subline; unique names do not", async () => {
    await render(
      "empty",
      view({
        recentProjects: [
          { name: "etude", path: "C:\\one\\etude.hornscribe.json", openedAt: 3 },
          { name: "etude", path: "D:\\two\\etude.hornscribe.json", openedAt: 2 },
          { name: "solo", path: "C:\\b\\solo.hornscribe.json", openedAt: 1 },
        ],
      }),
    );
    const dirs = [...document.querySelectorAll(".hs-recent__dir")].map(
      (e) => e.textContent,
    );
    expect(dirs).toEqual(["C:\\one", "D:\\two"]);
  });
});

describe("projectOpenFailed card (#364)", () => {
  it("a failed MRU path offers remove-and-close plus pick-another", async () => {
    const removed: string[] = [];
    const dismissed = vi.fn();
    await render(
      "audioError",
      view({
        issue: {
          kind: "projectOpenFailed",
          fileName: "etude.hornscribe.json",
          path: "C:\\a\\etude.hornscribe.json",
        },
        onRemoveRecent: (p) => removed.push(p),
        onDismissError: dismissed,
      }),
    );
    const labels = [...document.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).toContain(ja.import.errors.chooseAnother);
    const removeBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === ja.import.errors.removeFromRecent,
    );
    expect(removeBtn).toBeTruthy();
    await click(removeBtn!);
    expect(removed).toEqual(["C:\\a\\etude.hornscribe.json"]);
    expect(dismissed).toHaveBeenCalledOnce();
  });

  it("a byte-open failure has no remove affordance (nothing in the MRU)", async () => {
    await render(
      "audioError",
      view({
        issue: { kind: "projectOpenFailed", fileName: "dropped.hornscribe.json" },
      }),
    );
    const labels = [...document.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain(ja.import.errors.removeFromRecent);
    expect(labels).toContain(ja.import.errors.chooseAnother);
  });
});
