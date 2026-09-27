/**
 * @vitest-environment jsdom
 *
 * #55: スコア画面の採譜オプション dialog — draft seeding, field edits,
 * the invalid-range gate, and that apply hands the draft (not the live
 * options) to onApply.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptionOptionsDialog } from "./TranscriptionOptionsDialog";
import { DEFAULT_TRANSCRIPTION_OPTIONS } from "./types";
import type { TranscriptionOptions } from "./types";
import { ja } from "../strings/ja";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const NOOP = () => undefined;

const OPTIONS: TranscriptionOptions = { ...DEFAULT_TRANSCRIPTION_OPTIONS };

async function render(
  props: Partial<Parameters<typeof TranscriptionOptionsDialog>[0]> = {},
): Promise<{ onApply: ReturnType<typeof vi.fn> }> {
  const onApply = vi.fn<(next: TranscriptionOptions) => void>();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TranscriptionOptionsDialog
        open={true}
        onOpenChange={NOOP}
        options={OPTIONS}
        durationSec={600}
        onApply={onApply}
        {...props}
      />,
    );
    // Fluent portals the surface to document.body — let it mount.
    await new Promise((r) => setTimeout(r, 20));
  });
  return { onApply };
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function applyButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === ja.transcribeOptionsDialog.apply,
  );
}

function field(label: string): HTMLSelectElement | undefined {
  return [...document.querySelectorAll<HTMLSelectElement>("select")].find(
    (s) =>
      s.closest(".hs-field")?.textContent?.includes(label) ??
      s.getAttribute("aria-label") === label,
  );
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

describe("TranscriptionOptionsDialog (#55)", () => {
  it("renders the shared fields seeded from the live options", async () => {
    await render({ options: { ...OPTIONS, keyHint: "Ebm" } });
    expect(document.body.textContent).toContain(
      ja.import.audioOptions.label,
    );
    const keySelect = field(ja.import.audioOptions.keyHint);
    expect(keySelect?.value).toBe("Ebm");
  });

  it("apply hands the edited draft to onApply, not the live options", async () => {
    const { onApply } = await render();
    const keySelect = field(ja.import.audioOptions.keyHint);
    expect(keySelect).toBeTruthy();
    await act(async () => {
      keySelect!.value = "Fm";
      keySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(applyButton()!);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ ...OPTIONS, keyHint: "Fm" });
    // The caller's stored options object was never mutated.
    expect(OPTIONS.keyHint).toBe("auto");
  });

  it("an inverted 選択範囲 disables the apply button", async () => {
    await render({
      options: {
        ...OPTIONS,
        range: "selection",
        selectionStartSec: 120,
        selectionEndSec: 60,
      },
    });
    expect(applyButton()?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      ja.import.audioOptions.rangeInvalid,
    );
  });

  it("re-seeds the draft on reopen — a mid-session option change is picked up", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onApply = vi.fn<(next: TranscriptionOptions) => void>();
    const render_ = (open: boolean, options: TranscriptionOptions) =>
      root!.render(
        <TranscriptionOptionsDialog
          open={open}
          onOpenChange={NOOP}
          options={options}
          durationSec={600}
          onApply={onApply}
        />,
      );
    await act(async () => {
      render_(true, OPTIONS);
      await new Promise((r) => setTimeout(r, 20));
    });
    // Close, then reopen with different stored options (e.g. after a
    // quick-retranscribe committed a texture change).
    await act(async () => {
      render_(false, OPTIONS);
    });
    await act(async () => {
      render_(true, { ...OPTIONS, texture: "voices" });
      await new Promise((r) => setTimeout(r, 20));
    });
    await click(applyButton()!);
    expect(onApply.mock.calls.at(-1)?.[0].texture).toBe("voices");
  });
});

