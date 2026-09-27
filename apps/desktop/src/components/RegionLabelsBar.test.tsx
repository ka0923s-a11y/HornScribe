// @vitest-environment jsdom
/** #51: 区間ラベルの編集 — rename/範囲適用インライン操作の検証。 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { RegionLabelsBar } from "./RegionLabelsBar";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import type { RegionLabel } from "../workspace/regionLabels";
import type { SelectionRange } from "../import/selection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const LABEL: RegionLabel = {
  id: "rl-1",
  label: "サビ",
  startSec: 30,
  endSec: 60,
};

interface Calls {
  onAdd: Mock<(range: SelectionRange, name: string) => void>;
  onRename: Mock<(id: string, name: string) => void>;
  onApplySelection: Mock<(id: string, range: SelectionRange) => void>;
}

async function mount(calls: Calls, selection: { startSec: number; endSec: number } | null = null): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <RegionLabelsBar
        labels={[LABEL]}
        selection={selection}
        onAdd={calls.onAdd}
        onPick={vi.fn()}
        onRetranscribe={vi.fn()}
        onRemove={vi.fn()}
        onRename={calls.onRename}
        onApplySelection={calls.onApplySelection}
      />,
    );
  });
}

function freshCalls(): Calls {
  return {
    onAdd: vi.fn<(range: SelectionRange, name: string) => void>(),
    onRename: vi.fn<(id: string, name: string) => void>(),
    onApplySelection: vi.fn<(id: string, range: SelectionRange) => void>(),
  };
}

function editButton(): HTMLButtonElement {
  const btn = Array.from(host!.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === ja.regionLabels.edit,
  );
  if (!btn) throw new Error("edit button not found");
  return btn;
}

function editorInput(): HTMLInputElement {
  const input = host!.querySelector(".hs-labels__input");
  if (!(input instanceof HTMLInputElement)) throw new Error("no editor");
  return input;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("RegionLabelsBar edit (#51)", () => {
  it("renames via the inline editor", async () => {
    const calls = freshCalls();
    await mount(calls);
    await act(async () => editButton().click());
    const input = editorInput();
    expect(input.value).toBe("サビ");
    await act(async () => {
      // setNativeValue equivalent: assign then dispatch input event
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "Aメロ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(calls.onRename).toHaveBeenCalledWith("rl-1", "Aメロ");
    expect(calls.onAdd).not.toHaveBeenCalled();
  });

  it("Escape abandons the edit", async () => {
    const calls = freshCalls();
    await mount(calls);
    await act(async () => editButton().click());
    await act(async () => {
      editorInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(calls.onRename).not.toHaveBeenCalled();
  });

  it("applies the current selection as the label range", async () => {
    const calls = freshCalls();
    const sel = { startSec: 45, endSec: 90 };
    await mount(calls, sel);
    await act(async () => editButton().click());
    const apply = Array.from(host!.querySelectorAll("button")).find(
      (b) =>
        b.getAttribute("aria-label") === ja.regionLabels.applySelection,
    );
    expect(apply).toBeTruthy();
    await act(async () => apply!.click());
    expect(calls.onApplySelection).toHaveBeenCalledWith("rl-1", sel);
  });

  it("apply-selection is disabled without a waveform selection", async () => {
    const calls = freshCalls();
    await mount(calls, null);
    await act(async () => editButton().click());
    const apply = Array.from(host!.querySelectorAll("button")).find(
      (b) =>
        b.getAttribute("aria-label") === ja.regionLabels.applySelection,
    );
    expect(apply?.disabled).toBe(true);
  });
});
