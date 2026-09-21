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
  isTranscribing: false,
  isPlaying: false,
  loopEnabled: false,
  pitch: "concert",
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  reviewOpen: false,
  reviewCount: 0,
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
};

function mockContext(): CommandContext & { calls: string[] } {
  const calls: string[] = [];
  const spy = (name: string) => vi.fn(() => calls.push(name));
  return {
    calls,
    openAudio: spy("openAudio"),
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
    zoomScoreIn: spy("zoomScoreIn"),
    zoomScoreOut: spy("zoomScoreOut"),
    zoomScoreFit: spy("zoomScoreFit"),
    clearSelection: spy("clearSelection"),
    openSettings: spy("openSettings"),
    focusNextRegion: spy("focusNextRegion"),
    focusPreviousRegion: spy("focusPreviousRegion"),
    announce: spy("announce"),
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
      "review.next",
      "review.previous",
      "edit.undo",
      "edit.redo",
      "export.open",
      "score.zoomIn",
      "score.zoomOut",
      "score.zoomFit",
      "nav.nextRegion",
      "nav.previousRegion",
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
    expect(shortcutOf("export.open")).toContain("Ctrl+E");
    expect(shortcutOf("score.zoomIn")).toEqual(
      expect.arrayContaining(["Ctrl+=", "Ctrl++"]),
    );
    expect(shortcutOf("score.zoomOut")).toContain("Ctrl+-");
    expect(shortcutOf("score.zoomFit")).toContain("Ctrl+0");
    expect(shortcutOf("nav.nextRegion")).toContain("F6");
    expect(shortcutOf("nav.previousRegion")).toContain("Shift+F6");
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
