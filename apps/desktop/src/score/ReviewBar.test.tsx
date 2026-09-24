// @vitest-environment jsdom
/**
 * ReviewBar capability gating: whole-piece issues (no canonical note
 * targets) must disable the note-edit buttons instead of offering dead
 * controls, and the reason-specific action must carry its own tooltip.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ja } from "../strings/ja";
import { ReviewBar, type ReviewBarProps } from "./ReviewBar";
import type { ScoreReviewIssue } from "./review";
import { installJsdomStubs } from "../quality/testEnv";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const NOTE_ISSUE: ScoreReviewIssue = {
  id: "ri-000001",
  scoreRevision: "rev-test",
  canonicalNoteIds: ["sn-000001"],
  reason: "low_model_confidence",
  severity: "caution",
  evidence: {},
  status: "open",
};

const WHOLE_PIECE_ISSUE: ScoreReviewIssue = {
  ...NOTE_ISSUE,
  id: "ri-000002",
  canonicalNoteIds: [],
  reason: "meter_conflict",
};

function props(over: Partial<ReviewBarProps> = {}): ReviewBarProps {
  return {
    index: 0,
    total: 1,
    pending: 1,
    issue: NOTE_ISSUE,
    copy: {
      reasonTitle: "test",
      reasonDetail: "detail",
      severityLabel: "sev",
      statusLabel: "open",
    },
    noteDeleted: false,
    canUndo: false,
    canRedo: false,
    canEditNotes: true,
    canPlaySource: true,
    action: null,
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onPlaySource: vi.fn(),
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    onPitch: vi.fn(),
    onDeleteOrRestore: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onExit: vi.fn(),
    ...over,
  };
}

async function mount(p: ReviewBarProps): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ReviewBar {...p} />);
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

function button(label: string): HTMLButtonElement {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!el) throw new Error("button not found: " + label);
  return el as HTMLButtonElement;
}

describe("ReviewBar capability gating", () => {
  it("note-targeted issue: pitch/delete buttons are enabled", async () => {
    await mount(props());
    expect(button(ja.review.pitchUp).disabled).toBe(false);
    expect(button(ja.review.pitchDown).disabled).toBe(false);
    expect(button(ja.review.deleteNote).disabled).toBe(false);
    expect(button(ja.review.playSource).disabled).toBe(false);
  });

  it("whole-piece issue: note edits disabled, accept/dismiss stay on", async () => {
    await mount(
      props({ issue: WHOLE_PIECE_ISSUE, canEditNotes: false }),
    );
    expect(button(ja.review.pitchUp).disabled).toBe(true);
    expect(button(ja.review.pitchDown).disabled).toBe(true);
    expect(button(ja.review.deleteNote).disabled).toBe(true);
    // 問題なし / 対応不要 are still meaningful on whole-piece issues.
    expect(button(ja.review.markOk).disabled).toBe(false);
    expect(button(ja.review.dismiss).disabled).toBe(false);
  });

  it("disabled note buttons explain themselves via the tooltip label", async () => {
    await mount(
      props({ issue: WHOLE_PIECE_ISSUE, canEditNotes: false }),
    );
    // Fluent relationship="label" puts the tooltip on aria-label.
    expect(button(ja.review.pitchUp).getAttribute("aria-label")).toBe(
      ja.review.noteTargetRequired,
    );
  });

  it("playSource disables when the issue has no audible range", async () => {
    await mount(
      props({ issue: WHOLE_PIECE_ISSUE, canPlaySource: false }),
    );
    const b = button(ja.review.playSource);
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-label")).toBe(ja.review.noAudibleRange);
  });

  it("action button shows its own tooltip and runs the handler", async () => {
    const run = vi.fn();
    await mount(
      props({
        issue: WHOLE_PIECE_ISSUE,
        canEditNotes: false,
        action: {
          label: ja.review.openMeterEditor,
          tooltip: ja.review.openMeterEditorTip,
          run,
        },
      }),
    );
    const b = button(ja.review.openMeterEditor);
    expect(b.getAttribute("aria-label")).toBe(ja.review.openMeterEditorTip);
    await act(async () => {
      b.click();
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("no action prop renders no remedy button", async () => {
    await mount(props());
    const labels = [
      ja.review.retranscribeVoices,
      ja.review.retranscribeBasicPitch,
      ja.review.openMeterEditor,
    ];
    for (const l of labels) {
      expect(
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === l,
        ),
      ).toBe(false);
    }
  });
});
