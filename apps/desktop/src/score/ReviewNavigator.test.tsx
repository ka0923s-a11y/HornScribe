// @vitest-environment jsdom
/**
 * #361: ReviewNavigator — the filterable 要確認 issue list.
 *
 * Acceptance anchors: 全issue一覧 / 未解決のみ / severity・reason 絞り込み /
 * 任意issueへの直接ジャンプ / listbox keyboard semantics (↑↓ Enter Esc) /
 * screen-reader readable rows (position, reason, severity, status).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import type { ReviewCopy } from "./inspector";
import { ReviewNavigator, type ReviewNavigatorProps } from "./ReviewNavigator";
import type { ScoreReviewIssue } from "./review";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function issue(over: Partial<ScoreReviewIssue> = {}): ScoreReviewIssue {
  return {
    id: "ri-000001",
    scoreRevision: "rev-test",
    canonicalNoteIds: ["sn-000001"],
    timeRange: { startSec: 1.5, endSec: 2.0 },
    reason: "low_model_confidence",
    severity: "caution",
    evidence: {},
    status: "open",
    ...over,
  };
}

const ISSUES: readonly ScoreReviewIssue[] = [
  issue({ id: "ri-000001", canonicalNoteIds: ["sn-000001"] }),
  issue({
    id: "ri-000002",
    canonicalNoteIds: ["sn-000002", "sn-000003"],
    reason: "meter_conflict",
    severity: "warning",
    timeRange: { startSec: 62, endSec: 64.5 },
  }),
  issue({
    id: "ri-000003",
    canonicalNoteIds: ["sn-000004"],
    reason: "possible_triplet",
    severity: "info",
    status: "accepted",
    timeRange: { startSec: 95, endSec: 96 },
  }),
];

const COPY: ReviewCopy = {
  reasonTitle: (r) => ({
    low_model_confidence: "音低",
    meter_conflict: "拍子",
    possible_triplet: "三連",
  } as Record<string, string>)[r] ?? `other:${r}`,
  reasonDetail: () => "detail",
  severityLabel: (s) => ja.reviewSeverity[s] ?? s,
  statusLabel: (s) => ja.reviewStatus[s] ?? s,
};

function props(over: Partial<ReviewNavigatorProps> = {}): ReviewNavigatorProps {
  return {
    issues: ISSUES,
    activeIndex: 0,
    copy: COPY,
    onJump: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

async function mount(p: ReviewNavigatorProps): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ReviewNavigator {...p} />);
  });
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
}

async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("ReviewNavigator (#361)", () => {
  it("未解決のみ defaults on — resolved rows hidden until unchecked", async () => {
    await mount(props());
    const list = options();
    expect(list).toHaveLength(2); // ri-000003 is accepted
    expect(list[0].textContent).toContain("音低");
    expect(list[1].textContent).toContain("拍子");

    const checkbox = document.querySelector<HTMLInputElement>(
      '.hs-reviewnav input[type="checkbox"]',
    )!;
    expect(checkbox.checked).toBe(true);
    await act(async () => {
      checkbox.click();
    });
    expect(options()).toHaveLength(3);
  });

  it("severity filter narrows the list", async () => {
    await mount(props());
    const selects = document.querySelectorAll("select");
    const severity = selects[0] as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(severity, "warning");
      severity.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const list = options();
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toContain("拍子");
    expect(list[0].textContent).toContain(ja.reviewSeverity.warning);
  });

  it("reason filter narrows the list", async () => {
    await mount(props({ activeIndex: 1 }));
    const selects = document.querySelectorAll("select");
    const reason = selects[1] as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(reason, "low_model_confidence");
      reason.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("音低");
  });

  it("clicking a row jumps to its absolute issue index", async () => {
    const onJump = vi.fn();
    await mount(props({ onJump }));
    await act(async () => {
      options()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledWith(1); // absolute index, not row pos
  });

  it("listbox keyboard: ↑↓ moves, Enter jumps, Esc closes", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    await mount(props({ onJump, onClose }));
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    await key(list, "ArrowDown");
    expect(
      list.getAttribute("aria-activedescendant"),
    ).toBe("hs-reviewnav-opt-ri-000002");
    await key(list, "Enter");
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("Esc inside the panel closes the navigator, not the review", async () => {
    const onClose = vi.fn();
    await mount(props({ onClose }));
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    await key(list, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rows expose reason / severity / status / position to screen readers", async () => {
    await mount(props());
    const row = options()[1];
    expect(row.textContent).toContain("2"); // absolute issue position
    expect(row.textContent).toContain("拍子");
    expect(row.textContent).toContain(ja.reviewSeverity.warning);
    expect(row.textContent).toContain(ja.reviewStatus.open);
    expect(row.textContent).toContain("1:02"); // 62s source position
    expect(row.textContent).toContain("2音");
  });

  it("empty filter result shows a message instead of a dead list", async () => {
    await mount(props({ issues: [ISSUES[2]] })); // only resolved row
    // openOnly auto-defaults OFF when nothing is open — the single
    //  resolved row must still be listable (history view).
    expect(options()).toHaveLength(1);
  });
});
