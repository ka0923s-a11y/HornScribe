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
import type { LoadedAudio } from "./types";
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
    onPickProject: NOOP,
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

const AUDIO: LoadedAudio = {
  ref: { kind: "path", path: "C:\\audio\\take-03.wav", name: "take-03.wav" },
  fileName: "take-03.wav",
  format: "wav",
  sizeBytes: 14_680_064,
  durationSeconds: 600,
  sampleRate: 44_100,
  peaks: [0.2, 0.5, 0.8, 0.4],
  mediaSource: { kind: "blob", blob: new Blob() },
};

function transcribeButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === ja.score.transcribeStart,
  );
}

describe("audioReady selection validation (#346)", () => {
  const options = (s: number, e: number) => ({
    ...DEFAULT_TRANSCRIPTION_OPTIONS,
    range: "selection" as const,
    selectionStartSec: s,
    selectionEndSec: e,
  });

  it("an inverted 選択範囲 disables 採譜を開始 and flags the end field", async () => {
    await render("audioReady", view({ audio: AUDIO, options: options(120, 60) }));
    expect(transcribeButton()?.disabled).toBe(true);
    // The field error lives in the 採譜オプション popover — open it.
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === ja.import.audioOptions.label);
    expect(trigger).toBeTruthy();
    await click(trigger!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.body.textContent).toContain(
      ja.import.audioOptions.rangeInvalid,
    );
  });

  it("an equal pair is invalid the same way", async () => {
    await render("audioReady", view({ audio: AUDIO, options: options(60, 60) }));
    expect(transcribeButton()?.disabled).toBe(true);
  });

  it("a valid pair keeps 採譜を開始 enabled", async () => {
    await render("audioReady", view({ audio: AUDIO, options: options(60, 120) }));
    expect(transcribeButton()?.disabled).toBe(false);
  });

  it("全曲 mode ignores the stored seconds entirely", async () => {
    await render(
      "audioReady",
      view({
        audio: AUDIO,
        options: { ...options(120, 60), range: "all" },
      }),
    );
    expect(transcribeButton()?.disabled).toBe(false);
  });
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

describe("EMPTY project-open affordance (#369)", () => {
  it("the secondary CTA invokes onPickProject", async () => {
    const picked = vi.fn();
    await render("empty", view({ onPickProject: picked }));
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === ja.emptyState.openProject,
    );
    expect(btn).toBeTruthy();
    await click(btn!);
    expect(picked).toHaveBeenCalledTimes(1);
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
