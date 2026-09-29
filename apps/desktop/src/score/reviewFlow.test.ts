// @vitest-environment jsdom
/**
 * UI-050 acceptance: the 要確認 review flow is fully keyboard-drivable.
 *
 * The harness mirrors the App.tsx wiring — every review key goes through
 * the REAL command registry + keyboard dispatcher (no component-level key
 * handlers), and the context delegates to a ReviewSession on a real
 * ScoreDocumentPort, exactly as ScoreReadyWorkspace does.
 *
 * Pinned criterion: ≥20 issues processed with keys only, no menu opened.
 */
import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../commands/registry";
import type { CommandContext, CommandSnapshot } from "../commands/types";
import { KeyboardDispatcher } from "../keyboard/dispatcher";
import type { KeyEventLike } from "../keyboard/keys";
import { createFixtureScoreDocument } from "./fixtureDocument";
import type { ScoreDocumentPort } from "./document";
import {
  nextOpenIssueIndex,
  openIssues,
  type ScoreReviewIssue,
} from "./review";
import { ReviewSession } from "./reviewSession";

function twentyIssues(): readonly ScoreReviewIssue[] {
  // One issue per canonical note sn-000001…sn-000020 (fixture has 40).
  return Array.from({ length: 20 }, (_, i) => {
    const n = String(i + 1).padStart(6, "0");
    return {
      id: `ri-${n}`,
      scoreRevision: "rev-keyboard-test01",
      canonicalNoteIds: [`sn-${n}`],
      timeRange: { startSec: i * 0.6, endSec: i * 0.6 + 0.3 },
      reason: "low_model_confidence" as const,
      severity: "caution" as const,
      evidence: { modelConfidence: 0.5 },
      status: "open" as const,
    };
  });
}

/** Minimal workspace-side model: the bits of ScoreReadyWorkspace the
 *  command context calls (cursor, open flag, session, source replay). */
class ReviewHarness {
  cursor = 0;
  open = false;
  /** (startSec, endSec) ranges passed to 元音源を再生. */
  played: Array<[number, number]> = [];

  constructor(
    readonly doc: ScoreDocumentPort,
    readonly session: ReviewSession,
  ) {}

  get issues(): readonly ScoreReviewIssue[] {
    return this.doc.reviewIssues();
  }

  issue() {
    return this.issues[this.cursor] ?? null;
  }

  /** #361: mirrors ScoreReadyWorkspace.stepReviewOpen — walks the OPEN
   *  subset only; resolved rows are skipped, none-open is a no-op. */
  next(d: number) {
    const next = nextOpenIssueIndex(this.issues, this.cursor, d > 0 ? 1 : -1);
    if (next >= 0) this.cursor = next;
  }

  /** #361: mirrors advanceAfterResolve — a resolved cursor issue hands
   *  review to the next open one; stays put when it is still open
   *  (restore) or nothing open remains (all-done). */
  advance() {
    if (this.issues[this.cursor]?.status === "open") return;
    const next = nextOpenIssueIndex(this.issues, this.cursor, 1);
    if (next >= 0) this.cursor = next;
  }

  playSource() {
    const t = this.issue()?.timeRange;
    if (t) this.played.push([t.startSec, t.endSec]);
  }

  accept() {
    const i = this.issue();
    if (i && this.session.decide(i.id, "accepted")) this.advance();
  }

  dismiss() {
    const i = this.issue();
    if (i && this.session.decide(i.id, "dismissed")) this.advance();
  }

  pitch(delta: number) {
    // #361: pitch fixes intentionally do NOT auto-advance — a second
    //  Alt+↑↓ must hit the same issue for multi-semitone corrections.
    const i = this.issue();
    if (i) this.session.adjustPitch(i.id, delta);
  }

  deleteOrRestore() {
    const i = this.issue();
    if (!i || i.canonicalNoteIds.length === 0) return;
    const applied = this.session.setNoteDeleted(
      i.id,
      !this.session.isDeleted(i.canonicalNoteIds[0]),
    );
    if (applied) this.advance();
  }
}

function key(k: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

function setup(count = 20) {
  const doc = createFixtureScoreDocument({
    revisionId: "rev-keyboard-test01",
    issues: count === 20 ? twentyIssues() : twentyIssues().slice(0, count),
  });
  const session = new ReviewSession(doc);
  const h = new ReviewHarness(doc, session);
  const announced: string[] = [];

  const ctx: CommandContext = {
    openAudio: vi.fn(),
    openProject: vi.fn(),
    transcribe: vi.fn(),
    togglePlayPause: vi.fn(),
    stop: vi.fn(),
    jumpBack: vi.fn(),
    jumpForward: vi.fn(),
    seekToStart: vi.fn(),
    seekToEnd: vi.fn(),
    toggleLoop: vi.fn(),
    setPitchView: vi.fn(),
    openReview: () => {
      h.open = true;
      h.cursor = 0;
    },
    reviewNext: () => h.next(1),
    reviewPrevious: () => h.next(-1),
    reviewAccept: () => h.accept(),
    reviewDismiss: () => h.dismiss(),
    reviewPlaySource: () => h.playSource(),
    reviewPitchUp: () => h.pitch(1),
    reviewPitchDown: () => h.pitch(-1),
    reviewDeleteOrRestore: () => h.deleteOrRestore(),
    exitReview: () => {
      h.open = false;
    },
    // #361: mirrors reviewUndo — undoing a decision jumps the cursor
    //  back to the issue it reopened.
    undo: () => {
      const edit = session.undo();
      if (h.open && edit?.issueId != null) {
        const idx = h.issues.findIndex((i) => i.id === edit.issueId);
        if (idx >= 0) h.cursor = idx;
      }
    },
    redo: () => session.redo(),
    openExport: vi.fn(),
    zoomScoreIn: vi.fn(),
    zoomScoreOut: vi.fn(),
    zoomScoreFit: vi.fn(),
    // Esc exits the review workspace before clearing a selection (§12).
    clearSelection: () => {
      if (h.open) h.open = false;
    },
    openSettings: vi.fn(),
    openDiagnostics: vi.fn(),
    focusNextRegion: vi.fn(),
    focusPreviousRegion: vi.fn(),
    announce: (m) => announced.push(m),
  };

  const snapshot = (): CommandSnapshot => ({
    hasAudio: true,
    hasScore: true,
    hasPolyphony: false,
    isTranscribing: false,
    isPlaying: false,
    loopEnabled: false,
    pitch: "concert",
    canUndo: session.canUndo,
    canRedo: session.canRedo,
    hasSelection: false,
    hasRestSelection: false,
    hasWaveformSelection: false,
    reviewOpen: h.open,
    reviewIssueEditable: (h.issue()?.canonicalNoteIds.length ?? 0) > 0,
    reviewCount: session.pendingCount(),
    reviewTotal: session.issues().length,
     isRecording: false,
     isRecordingPaused: false,
      isRecordingStarting: false,
     auditionEnabled: false,
    view: "workspace",
  });

  const dispatcher = new KeyboardDispatcher({
    registry: createCommandRegistry(),
    getSnapshot: snapshot,
    context: ctx,
  });
  return { doc, session, h, dispatcher, announced };
}

describe("keyboard-only review processing (acceptance: 20 items, no menus)", () => {
  it("processes 20 issues with ← → R O Shift+O Alt+↑ Alt+↓ Delete alone", () => {
    const { session, h, dispatcher } = setup(20);
    // Review commands stay disabled until the workspace is open.
    expect(dispatcher.handleKeyDown(key("o")).kind).toBe("disabled");
    expect(h.cursor).toBe(0);

    h.open = true; // openReview() via the 要確認 button/command
    for (let i = 0; i < 20; i += 1) {
      const id = session.issues()[h.cursor].id;
      // 元音源を再生 (R) — replays the issue's source range.
      expect(dispatcher.handleKeyDown(key("r")).commandId).toBe(
        "review.playSource",
      );
      // Resolve by cycling the real action set: accept, pitch-fix,
      // dismiss, delete — all without touching a menu.
      const action = i % 4;
      const cmd =
        action === 0
          ? dispatcher.handleKeyDown(key("o")).commandId
          : action === 1
            ? dispatcher.handleKeyDown(key("ArrowUp", { altKey: true }))
                .commandId
            : action === 2
              ? dispatcher.handleKeyDown(key("O", { shiftKey: true }))
                  .commandId
              : dispatcher.handleKeyDown(key("Delete")).commandId;
      expect(cmd).toMatch(/^review\./);
      expect(session.statusOf(id)).not.toBe("open");
      // #361: accept/dismiss/delete auto-advance to the next open
      //  issue; the pitch fix is iterative (stays) so it still needs
      //  an explicit 次へ — direct navigation, always one keypress.
      if (action === 1) {
        expect(dispatcher.handleKeyDown(key("ArrowRight")).commandId).toBe(
          "review.next",
        );
      }
    }
    expect(session.pendingCount()).toBe(0);
    expect(h.played).toHaveLength(20);
    // Every range replayed is the focused issue's own source span.
    expect(h.played[0]).toEqual([0, 0.3]);
    expect(h.played[19]).toEqual([19 * 0.6, 19 * 0.6 + 0.3]);
  });

  it("mixed decisions land correctly: accepted / fixed / dismissed / deleted", () => {
    const { doc, session, h, dispatcher } = setup(20);
    h.open = true;
    // #361: accept/dismiss auto-advance; pitch stays (iterative) and
    //  ArrowRight steps to the next OPEN issue.
    dispatcher.handleKeyDown(key("o")); // ri-000001 accepted → cursor auto-advances to ri-000002
    dispatcher.handleKeyDown(key("ArrowUp", { altKey: true })); // ri-000002 fixed + pitch (stays)
    dispatcher.handleKeyDown(key("ArrowRight")); // → ri-000003 (ri-000002 is fixed — skipped)
    dispatcher.handleKeyDown(key("O", { shiftKey: true })); // ri-000003 dismissed → cursor on ri-000004
    dispatcher.handleKeyDown(key("Delete")); // ri-000004 deleted→fixed
    expect(session.statusOf("ri-000001")).toBe("accepted");
    expect(session.statusOf("ri-000002")).toBe("fixed");
    expect(session.statusOf("ri-000003")).toBe("dismissed");
    expect(session.statusOf("ri-000004")).toBe("fixed");
    expect(session.noteEditOf("sn-000002").pitchDelta).toBe(1);
    expect(session.isDeleted("sn-000004")).toBe(true);
    // The document model carries the decisions (revision-keyed).
    expect(
      openIssues(doc.reviewIssues()).map((i) => i.id),
    ).not.toContain("ri-000001");
  });

  it("Ctrl+Z / Ctrl+Shift+Z undo and redo review actions mid-flow", () => {
    const { session, h, dispatcher } = setup(20);
    h.open = true;
    // #361: accepting #1 auto-advances the cursor to #2.
    dispatcher.handleKeyDown(key("o")); // accept #1 → cursor on #2
    dispatcher.handleKeyDown(key("Delete")); // delete #2's note → cursor on #3
    expect(session.isDeleted("sn-000002")).toBe(true);

    expect(
      dispatcher.handleKeyDown(key("z", { ctrlKey: true })).commandId,
    ).toBe("edit.undo");
    expect(session.isDeleted("sn-000002")).toBe(false);
    expect(session.statusOf("ri-000002")).toBe("open");
    // #361: undo returns the cursor to the issue it reopened.
    expect(h.cursor).toBe(1);

    expect(
      dispatcher.handleKeyDown(key("Z", { ctrlKey: true, shiftKey: true }))
        .commandId,
    ).toBe("edit.redo");
    expect(session.isDeleted("sn-000002")).toBe(true);
    expect(session.statusOf("ri-000002")).toBe("fixed");
  });

  it("← / → navigate both directions and wrap at the ends", () => {
    const { h, dispatcher } = setup(20);
    h.open = true;
    dispatcher.handleKeyDown(key("ArrowLeft")); // wraps to last
    expect(h.cursor).toBe(19);
    dispatcher.handleKeyDown(key("ArrowRight")); // wraps back to first
    expect(h.cursor).toBe(0);
    dispatcher.handleKeyDown(key("ArrowRight"));
    dispatcher.handleKeyDown(key("ArrowRight"));
    expect(h.cursor).toBe(2);
  });

  it("#361: → skips resolved issues — a resumed review never re-passes them", () => {
    const { session, h, dispatcher } = setup(20);
    // Simulate a reopened project whose earlier rows are already
    //  decided (decisions persist in the document, no undo needed).
    for (const id of ["ri-000002", "ri-000003", "ri-000004"]) {
      session.decide(id, "accepted");
    }
    h.open = true;
    h.cursor = 0; // openReview lands on the first open issue
    dispatcher.handleKeyDown(key("ArrowRight"));
    // ri-000002..4 are accepted — the next open is ri-000005.
    expect(h.cursor).toBe(4);
    dispatcher.handleKeyDown(key("ArrowLeft"));
    expect(h.cursor).toBe(0);
  });

  it("#361: resolving the last open issue wraps back to earlier open rows", () => {
    const { session, h, dispatcher } = setup(20);
    h.open = true;
    h.cursor = 19;
    // Resolve the tail — cursor must wrap to the first still-open row.
    dispatcher.handleKeyDown(key("o")); // ri-000020 accepted
    expect(session.statusOf("ri-000020")).toBe("accepted");
    expect(h.cursor).toBe(0);
  });

  it("#361: resolving the final open issue stays put (all-done, no auto-exit)", () => {
    const { session, h, dispatcher } = setup(20);
    h.open = true;
    for (let i = 0; i < 19; i += 1) dispatcher.handleKeyDown(key("o"));
    expect(h.cursor).toBe(19);
    dispatcher.handleKeyDown(key("o")); // last one
    expect(session.pendingCount()).toBe(0);
    expect(h.cursor).toBe(19); // stays — the bar shows all-done
    expect(h.open).toBe(true); // review does not auto-close
  });

  it("#361: review.open stays enabled for a fully-resolved history", () => {
    const { session, h, dispatcher } = setup(20);
    for (let i = 0; i < 20; i += 1) {
      session.decide(`ri-${String(i + 1).padStart(6, "0")}`, "accepted");
    }
    expect(session.pendingCount()).toBe(0);
    // review.open is gated on reviewTotal, not pending — a resolved
    //  history must keep the re-entry path alive (registry-level
    //  predicate check via the real registry).
    const registry = createCommandRegistry();
    const resolvedSnapshot = (): CommandSnapshot => ({
      hasAudio: true,
      hasScore: true,
      isTranscribing: false,
      isPlaying: false,
      hasPolyphony: false,
      loopEnabled: false,
      pitch: "concert",
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      hasSelection: false,
      hasRestSelection: false,
      hasWaveformSelection: false,
      reviewOpen: h.open,
      reviewIssueEditable: false,
      reviewCount: session.pendingCount(),
      reviewTotal: session.issues().length,
      isRecording: false,
      isRecordingPaused: false,
      isRecordingStarting: false,
      auditionEnabled: false,
      view: "workspace",
    });
    expect(registry.isEnabled("review.open", resolvedSnapshot())).toBe(true);
    h.open = true; // what ctx.openReview() does once invoked
    dispatcher.handleKeyDown(key("ArrowRight"));
    // Nothing is open — the open-only stepper is a no-op, cursor stays.
    expect(h.cursor).toBe(0);
  });

  it("Esc exits the review workspace; review keys disable again", () => {
    const { h, dispatcher } = setup(20);
    h.open = true;
    expect(
      dispatcher.handleKeyDown(key("Escape")).commandId,
    ).toBe("edit.clearSelection");
    expect(h.open).toBe(false);
    expect(dispatcher.handleKeyDown(key("o")).kind).toBe("disabled");
    // #114: ArrowRight is shared - outside review it routes to the
    // score's next-note navigation instead of being swallowed.
    expect(dispatcher.handleKeyDown(key("ArrowRight")).commandId).toBe(
      "score.selectNext",
    );
  });

  it("all 20 items stay resolved after the pass (decisions persisted)", () => {
    const { doc, session, h, dispatcher } = setup(20);
    h.open = true;
    for (let i = 0; i < 20; i += 1) {
      dispatcher.handleKeyDown(key("o"));
    }
    expect(openIssues(doc.reviewIssues())).toHaveLength(0);
    expect(doc.reviewIssues()).toHaveLength(20);
    expect(doc.reviewIssues().every((i) => i.status === "accepted")).toBe(true);
    expect(session.canUndo).toBe(true);
  });
});
