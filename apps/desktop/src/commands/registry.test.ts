/**
 * Command registry tests (issue UI-012 acceptance: "shortcut conflict test
 * exists", "all commands have Japanese labels").
 *
 * Pure logic — no DOM needed.
 */

import { describe, expect, it, vi } from "vitest";
import { ja } from "../strings/ja";
import { CommandRegistry, createCommandRegistry } from "./registry";
import type {
  Command,
  CommandContext,
  CommandSnapshot,
} from "./types";

const SNAPSHOT_EMPTY: CommandSnapshot = {
  hasAudio: false,
  hasScore: false,
  hasPolyphony: false,
  isTranscribing: false,
  isPlaying: false,
  loopEnabled: false,
  pitch: "concert",
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasRestSelection: false,
  hasWaveformSelection: false,
  reviewOpen: false,
  reviewIssueEditable: false,
  reviewCount: 0,
  reviewTotal: 0,
      isRecording: false,
      isRecordingPaused: false,
      isRecordingStarting: false,
      auditionEnabled: false,
  view: "workspace",
};

const SNAPSHOT_SCORE: CommandSnapshot = {
  ...SNAPSHOT_EMPTY,
  hasAudio: true,
  hasScore: true,
  canUndo: true,
  canRedo: true,
  hasSelection: true,
  reviewCount: 3,
  reviewTotal: 3,
      isRecording: false,
      isRecordingPaused: false,
      isRecordingStarting: false,
      auditionEnabled: false,
};

function mockContext(): CommandContext & { calls: string[] } {
  const calls: string[] = [];
  const spy = (name: string) => vi.fn(() => calls.push(name));
  return {
    calls,
    openAudio: spy("openAudio"),
    openProject: spy("openProject"),
    transcribe: spy("transcribe"),
    togglePlayPause: spy("togglePlayPause"),
    stop: spy("stop"),
    jumpBack: spy("jumpBack"),
    jumpForward: spy("jumpForward"),
    seekToStart: spy("seekToStart"),
    seekToEnd: spy("seekToEnd"),
    toggleLoop: spy("toggleLoop"),
    setPitchView: spy("setPitchView"),
    openReview: spy("openReview"),
    reviewNext: spy("reviewNext"),
    reviewPrevious: spy("reviewPrevious"),
    undo: spy("undo"),
    redo: spy("redo"),
    openExport: spy("openExport"),
    openInMuseScore: spy("openInMuseScore"),
    saveProject: spy("saveProject"),
    saveProjectAs: spy("saveProjectAs"),
    noteDurationScale: spy("noteDurationScale"),
    shiftSelectedOnset: spy("shiftSelectedOnset"),
    toggleSelectedTie: spy("toggleSelectedTie"),
    zoomScoreIn: spy("zoomScoreIn"),
    zoomScoreOut: spy("zoomScoreOut"),
    zoomScoreFit: spy("zoomScoreFit"),
    clearSelection: spy("clearSelection"),
    openSettings: spy("openSettings"),
    openDiagnostics: spy("openDiagnostics"),
    focusNextRegion: spy("focusNextRegion"),
    focusPreviousRegion: spy("focusPreviousRegion"),
    announce: spy("announce"),
    captureLastSource: spy("captureLastSource"),
    collapseToMelody: spy("collapseToMelody"),
  };
}

describe("command definitions", () => {
  const registry = createCommandRegistry();

  it("covers every command required by UI-012 / GUI_UX_SPEC", () => {
    const ids = registry.list().map((c) => c.id);
    for (const required of [
      "file.openAudio",
      "score.transcribe",
      "transport.playPause",
      "transport.stop",
      "transport.jumpBack",
      "transport.jumpForward",
      "transport.toggleLoop",
      "view.concertPitch",
      "view.hornF",
      "review.open",
      "review.next",
      "review.previous",
      "review.playSource",
      "review.accept",
      "review.dismiss",
      "review.pitchUp",
      "review.pitchDown",
      "review.deleteOrRestore",
      "review.exit",
      "edit.undo",
      "edit.redo",
      "export.open",
      "export.openInMuseScore",
      "score.zoomIn",
      "score.zoomOut",
      "score.zoomFit",
      "score.noteLonger",
      "score.noteShorter",
      "score.noteShiftLeft",
      "score.noteShiftRight",
      "score.toggleTie",
      "nav.nextRegion",
      "nav.previousRegion",
      "app.settings",
      "app.diagnostics",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("ships with zero shortcut conflicts", () => {
    expect(registry.detectConflicts()).toEqual([]);
  });

  it("every command has a non-empty Japanese title", () => {
    const known = new Set<string>(Object.values(ja.commands));
    for (const command of registry.list()) {
      expect(command.title.length).toBeGreaterThan(0);
      // Titles come from the shared copy module, not ad-hoc strings.
      expect(known.has(command.title)).toBe(true);
    }
  });

  it("initial bindings match the spec table (§9, §15, §22)", () => {
    const shortcutOf = (id: string) =>
      registry.get(id)?.shortcuts ?? [];
    expect(shortcutOf("file.openAudio")).toContain("Ctrl+O");
    expect(shortcutOf("transport.playPause")).toEqual(
      expect.arrayContaining(["Space", "K"]),
    );
    expect(shortcutOf("transport.stop")).toContain("Shift+Space");
    expect(shortcutOf("transport.jumpBack")).toContain("J");
    expect(shortcutOf("transport.jumpForward")).toContain("L");
    expect(shortcutOf("transport.toggleLoop")).toContain("Ctrl+L");
    expect(shortcutOf("view.concertPitch")).toContain("Ctrl+1");
    expect(shortcutOf("view.hornF")).toContain("Ctrl+2");
    expect(shortcutOf("edit.undo")).toContain("Ctrl+Z");
    expect(shortcutOf("edit.redo")).toContain("Ctrl+Shift+Z");
    // UI-050 review keys (P4-validated set).
    expect(shortcutOf("review.next")).toContain("ArrowRight");
    expect(shortcutOf("review.previous")).toContain("ArrowLeft");
    expect(shortcutOf("review.playSource")).toContain("R");
    expect(shortcutOf("review.accept")).toContain("O");
    expect(shortcutOf("review.dismiss")).toContain("Shift+O");
    expect(shortcutOf("review.pitchUp")).toContain("Alt+ArrowUp");
    expect(shortcutOf("review.pitchDown")).toContain("Alt+ArrowDown");
    expect(shortcutOf("review.deleteOrRestore")).toContain("Delete");
    expect(shortcutOf("export.open")).toContain("Ctrl+E");
    // #221: project save pair — Ctrl+S writes back, Ctrl+Shift+S re-picks.
    expect(shortcutOf("project.save")).toContain("Ctrl+S");
    expect(shortcutOf("project.saveAs")).toContain("Ctrl+Shift+S");
    expect(shortcutOf("score.zoomIn")).toEqual(
      expect.arrayContaining(["Ctrl+=", "Ctrl++"]),
    );
    expect(shortcutOf("score.zoomOut")).toContain("Ctrl+-");
    expect(shortcutOf("score.zoomFit")).toContain("Ctrl+0");
    expect(shortcutOf("nav.nextRegion")).toContain("F6");
    expect(shortcutOf("nav.previousRegion")).toContain("Shift+F6");
    // #118: Ctrl+R re-runs the last-used capture flow.
    expect(shortcutOf("media.captureLastSource")).toContain("Ctrl+R");
  });

  it("#118: captureLastSource gates like the other capture commands", () => {
    const ctx = mockContext();
    const recording: CommandSnapshot = {
      ...SNAPSHOT_EMPTY,
      isRecording: true,
    };
    const transcribing: CommandSnapshot = {
      ...SNAPSHOT_EMPTY,
      isTranscribing: true,
    };
    expect(registry.invoke("media.captureLastSource", ctx, recording)).toBe(
      false,
    );
    expect(registry.invoke("media.captureLastSource", ctx, transcribing)).toBe(
      false,
    );
    expect(registry.invoke("media.captureLastSource", ctx, SNAPSHOT_EMPTY)).toBe(
      true,
    );
    expect(ctx.calls).toEqual(["captureLastSource"]);
  });

  it("#221: project save pair gates on a score and invokes the ctx", () => {
    const ctx = mockContext();
    // No score → both stay unavailable; a running job also locks them.
    for (const id of ["project.save", "project.saveAs"]) {
      expect(registry.invoke(id, ctx, SNAPSHOT_EMPTY)).toBe(false);
      expect(
        registry.invoke(id, ctx, {
          ...SNAPSHOT_SCORE,
          isTranscribing: true,
        }),
      ).toBe(false);
      expect(registry.invoke(id, ctx, SNAPSHOT_SCORE)).toBe(true);
    }
    expect(ctx.calls).toEqual(["saveProject", "saveProjectAs"]);
  });

  it("#115: rhythm edits gate on a note selection and invoke the ctx", () => {
    const ctx = mockContext();
    // SNAPSHOT_SCORE has a selection; EMPTY does not.
    for (const id of [
      "score.noteLonger",
      "score.noteShorter",
      "score.noteShiftLeft",
      "score.noteShiftRight",
      "score.toggleTie",
    ]) {
      expect(registry.invoke(id, ctx, SNAPSHOT_EMPTY)).toBe(false);
      expect(registry.invoke(id, ctx, SNAPSHOT_SCORE)).toBe(true);
    }
    expect(ctx.calls).toEqual([
      "noteDurationScale",
      "noteDurationScale",
      "shiftSelectedOnset",
      "shiftSelectedOnset",
      "toggleSelectedTie",
    ]);
    // Review owns the arrows/keys — rhythm edits stay disabled inside it.
    const reviewing: CommandSnapshot = { ...SNAPSHOT_SCORE, reviewOpen: true };
    expect(registry.invoke("score.toggleTie", ctx, reviewing)).toBe(false);
  });

  it("#123: collapseToMelody gates on playable polyphony", () => {
    const ctx = mockContext();
    // EMPTY: no score. SNAPSHOT_SCORE has a score but monophonic
    // content — hasPolyphony stays false, so the command stays off.
    expect(registry.invoke("score.collapseToMelody", ctx, SNAPSHOT_EMPTY)).toBe(
      false,
    );
    expect(registry.invoke("score.collapseToMelody", ctx, SNAPSHOT_SCORE)).toBe(
      false,
    );
    const poly: CommandSnapshot = { ...SNAPSHOT_SCORE, hasPolyphony: true };
    expect(registry.invoke("score.collapseToMelody", ctx, poly)).toBe(true);
    // Inside review the score-writing commands stay off.
    expect(
      registry.invoke("score.collapseToMelody", ctx, {
        ...poly,
        reviewOpen: true,
      }),
    ).toBe(false);
    expect(ctx.calls).toEqual(["collapseToMelody"]);
  });

  // #366: the score clock is the fallback transport — these stay
  // enabled with a score and no audio.
  it("transport stays enabled score-only", () => {
    const registry = createCommandRegistry();
    const scoreOnly: CommandSnapshot = {
      ...SNAPSHOT_SCORE,
      hasAudio: false,
    };
    for (const id of [
      "transport.playPause",
      "transport.stop",
      "transport.jumpBack",
      "transport.jumpForward",
      "transport.seekStart",
      "transport.seekEnd",
      "transport.toggleLoop",
    ]) {
      expect(registry.get(id)?.isEnabled?.(scoreOnly)).toBe(true);
    }
    // Audio-only controls stay gated — source mute means nothing
    // without a source.
    expect(
      registry.get("transport.toggleSourceMute")?.isEnabled?.(scoreOnly),
    ).toBe(false);
  });
});

describe("conflict detection", () => {
  const cmd = (over: Partial<Command> & { id: string }): Command => ({
    title: "テスト",
    section: "app",
    run: () => undefined,
    ...over,
  });

  it("detects two commands bound to the same chord", () => {
    const registry = new CommandRegistry([
      cmd({ id: "a.one", shortcuts: ["Ctrl+P"] }),
      cmd({ id: "b.two", shortcuts: ["Ctrl+P"] }),
    ]);
    expect(registry.detectConflicts()).toEqual([
      { shortcut: "Ctrl+P", commandIds: ["a.one", "b.two"] },
    ]);
  });

  it("normalizes bindings before comparing (Ctrl+shift+p == Ctrl+Shift+P)", () => {
    const registry = new CommandRegistry([
      cmd({ id: "a.one", shortcuts: ["Ctrl+Shift+P"] }),
      cmd({ id: "b.two", shortcuts: ["ctrl+shift+p"] }),
    ]);
    expect(registry.detectConflicts()).toHaveLength(1);
  });

  it("detects multi-chord sequence collisions", () => {
    const registry = new CommandRegistry([
      cmd({ id: "a.one", shortcuts: ["Ctrl+K Ctrl+C"] }),
      cmd({ id: "b.two", shortcuts: ["Ctrl+K Ctrl+C"] }),
    ]);
    expect(registry.detectConflicts()).toHaveLength(1);
  });

  it("does not flag two bindings owned by the same command", () => {
    const registry = new CommandRegistry([
      cmd({ id: "a.one", shortcuts: ["Space", "K"] }),
      cmd({ id: "b.two", shortcuts: ["L"] }),
    ]);
    expect(registry.detectConflicts()).toEqual([]);
  });

  it("does not flag a chord vs. a longer sequence sharing its prefix", () => {
    // "Ctrl+K" alone and "Ctrl+K Ctrl+C" coexist: the single chord fires
    // immediately, so this is intentionally strict — they DO conflict at
    // the dispatcher level… except the first chord completes its binding
    // before the sequence can continue. Flagging it keeps authors honest:
    // sequences must not share their first chord with a single binding.
    const registry = new CommandRegistry([
      cmd({ id: "a.one", shortcuts: ["Ctrl+K"] }),
      cmd({ id: "b.two", shortcuts: ["Ctrl+K Ctrl+C"] }),
    ]);
    // Distinct normalized keys — no conflict between the *sequences*, the
    // dispatcher resolves "Ctrl+K" as a full match before any second chord.
    expect(registry.detectConflicts()).toEqual([]);
  });

  it("createCommandRegistry throws when definitions contain a conflict", () => {
    expect(() =>
      createCommandRegistry([
        cmd({ id: "a.one", shortcuts: ["Ctrl+X"] }),
        cmd({ id: "b.two", shortcuts: ["Ctrl+X"] }),
      ]),
    ).toThrow(/conflict/i);
  });

  it("register() rejects a duplicate command id", () => {
    const registry = new CommandRegistry([cmd({ id: "a.one" })]);
    expect(() => registry.register(cmd({ id: "a.one" }))).toThrow(
      /duplicate/i,
    );
  });
});

describe("invoke", () => {
  const registry = createCommandRegistry();

  it("runs an enabled command", () => {
    const ctx = mockContext();
    expect(registry.invoke("file.openAudio", ctx, SNAPSHOT_EMPTY)).toBe(true);
    expect(ctx.calls).toEqual(["openAudio"]);
  });

  it("refuses a disabled command — non-executable from any surface", () => {
    const ctx = mockContext();
    // 採譜 needs audio; EMPTY state has none.
    expect(registry.invoke("score.transcribe", ctx, SNAPSHOT_EMPTY)).toBe(
      false,
    );
    expect(ctx.transcribe).not.toHaveBeenCalled();
  });

  it("returns false for unknown ids", () => {
    const ctx = mockContext();
    expect(registry.invoke("no.such", ctx, SNAPSHOT_EMPTY)).toBe(false);
  });

  it("enables transport/edit/export once a score exists", () => {
    const ctx = mockContext();
    for (const [id, spy] of [
      ["transport.toggleLoop", "toggleLoop"],
      ["edit.undo", "undo"],
      ["export.open", "openExport"],
      ["export.openInMuseScore", "openInMuseScore"],
      ["review.next", null], // needs reviewOpen — stays disabled
    ] as const) {
      const ran = registry.invoke(id, ctx, SNAPSHOT_SCORE);
      if (spy) {
        expect(ran).toBe(true);
        expect(ctx.calls).toContain(spy);
      } else {
        expect(ran).toBe(false);
      }
    }
  });
});

describe("visibility", () => {
  const registry = createCommandRegistry();

  it("review commands stay off surfaces until a review exists", () => {
    const visibleEmpty = registry
      .listVisible(SNAPSHOT_EMPTY)
      .map((c) => c.id);
    expect(visibleEmpty).not.toContain("review.open");
    expect(visibleEmpty).not.toContain("review.next");

    const reviewing: CommandSnapshot = {
      ...SNAPSHOT_SCORE,
      reviewOpen: true,
    };
    const visibleReview = registry
      .listVisible(reviewing)
      .map((c) => c.id);
    expect(visibleReview).toContain("review.open");
    expect(visibleReview).toContain("review.next");
    expect(visibleReview).toContain("review.previous");
  });
});
