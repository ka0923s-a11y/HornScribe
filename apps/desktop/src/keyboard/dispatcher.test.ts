/**
 * @vitest-environment jsdom
 *
 * Keyboard dispatcher tests (issue UI-012): IME safety, text-entry and
 * control scoping, disabled-command swallowing, auto-repeat and multi-chord
 * sequences.
 */

import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../commands/registry";
import { createCommandDefinitions } from "../commands/definitions";
import type {
  Command,
  CommandContext,
  CommandSnapshot,
} from "../commands/types";
import { KeyboardDispatcher } from "./dispatcher";
import type { KeyEventLike } from "./keys";

const EMPTY: CommandSnapshot = {
  hasAudio: false,
  hasScore: false,
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
      isRecording: false,
      isRecordingPaused: false,
      auditionEnabled: false,
  view: "workspace",
};

const WITH_AUDIO: CommandSnapshot = { ...EMPTY, hasAudio: true };

function mockContext() {
  const calls: string[] = [];
  const spy = (name: string) => vi.fn(() => calls.push(name));
  const ctx: CommandContext = {
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
    openDiagnostics: spy("openDiagnostics"),
    focusNextRegion: spy("focusNextRegion"),
    focusPreviousRegion: spy("focusPreviousRegion"),
    announce: spy("announce"),
  };
  return { ctx, calls };
}

function key(
  k: string,
  init: Partial<KeyEventLike> = {},
): KeyEventLike {
  return {
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  };
}

function setup(
  snapshot: CommandSnapshot,
  commands: readonly Command[] = createCommandDefinitions(),
) {
  const { ctx, calls } = mockContext();
  const dispatcher = new KeyboardDispatcher({
    registry: new CommandRegistry(commands),
    getSnapshot: () => snapshot,
    context: ctx,
  });
  return { dispatcher, calls };
}

describe("basic dispatch", () => {
  it("runs a bound command and asks for preventDefault", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const result = dispatcher.handleKeyDown(key(" "));
    expect(result).toMatchObject({
      kind: "ran",
      commandId: "transport.playPause",
      shouldPreventDefault: true,
    });
    expect(calls).toEqual(["togglePlayPause"]);
  });

  it("K is the second play/pause binding (§9)", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    expect(dispatcher.handleKeyDown(key("k")).commandId).toBe(
      "transport.playPause",
    );
    expect(calls).toEqual(["togglePlayPause"]);
  });

  it("letters match case-insensitively but modifiers stay strict", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    // CapsLock makes e.key "J" — still the same chord.
    expect(dispatcher.handleKeyDown(key("J")).commandId).toBe(
      "transport.jumpBack",
    );
    // But Shift+L is not bound — modifier mismatch means no dispatch.
    const shifted = dispatcher.handleKeyDown(key("L", { shiftKey: true }));
    expect(shifted.kind).toBe("unmatched");
    expect(calls).toEqual(["jumpBack"]);
  });

  it("unmatched keys pass through without preventDefault", () => {
    const { dispatcher } = setup(WITH_AUDIO);
    const result = dispatcher.handleKeyDown(key("q"));
    expect(result).toMatchObject({
      kind: "unmatched",
      shouldPreventDefault: false,
    });
  });
});

describe("disabled commands stay non-executable", () => {
  it("swallows a known-but-disabled shortcut (no run, preventDefault)", () => {
    const { dispatcher, calls } = setup(EMPTY); // no audio
    const result = dispatcher.handleKeyDown(key(" "));
    expect(result).toMatchObject({
      kind: "disabled",
      commandId: "transport.playPause",
      shouldPreventDefault: true,
    });
    expect(calls).toEqual([]);
  });

  it("Ctrl+Z does nothing when the undo stack is empty", () => {
    const { dispatcher, calls } = setup(EMPTY);
    expect(dispatcher.handleKeyDown(key("z", { ctrlKey: true })).kind).toBe(
      "disabled",
    );
    expect(calls).toEqual([]);
  });
});

describe("IME safety (UI_COPY_CONTRACT / MASTER_PLAN §8)", () => {
  it("ignores events during composition", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const result = dispatcher.handleKeyDown(
      key("k", { isComposing: true }),
    );
    expect(result.kind).toBe("suppressed");
    expect(result.shouldPreventDefault).toBe(false);
    expect(calls).toEqual([]);
  });

  it("ignores the keyCode 229 IME sentinel", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const result = dispatcher.handleKeyDown(
      key("Process", { keyCode: 229 }),
    );
    expect(result.kind).toBe("suppressed");
    expect(calls).toEqual([]);
  });
});

describe("focus scopes", () => {
  function el(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    const node = host.firstElementChild as HTMLElement;
    document.body.appendChild(node);
    return node;
  }

  it("suppresses J/K/L inside text input (spec §9)", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const input = el('<input type="text">');
    const result = dispatcher.handleKeyDown(key("k", { target: input }));
    expect(result.kind).toBe("suppressed");
    expect(calls).toEqual([]);
    input.remove();
  });

  it("suppresses Ctrl+Z inside text input — field-level undo wins", () => {
    const { dispatcher, calls } = setup({ ...EMPTY, canUndo: true });
    const textarea = el("<textarea></textarea>");
    const result = dispatcher.handleKeyDown(
      key("z", { ctrlKey: true, target: textarea }),
    );
    expect(result.kind).toBe("suppressed");
    expect(calls).toEqual([]);
    textarea.remove();
  });

  it("suppresses everything inside a modal surface by default", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const dialog = el('<div role="dialog"><button type="button">x</button></div>');
    const inside = dialog.querySelector("button")!;
    for (const k of ["k", " "]) {
      expect(
        dispatcher.handleKeyDown(key(k, { target: inside })).kind,
      ).toBe("suppressed");
    }
    // Even a Ctrl binding does not fire inside a modal.
    expect(
      dispatcher.handleKeyDown(
        key("o", { ctrlKey: true, target: inside }),
      ).kind,
    ).toBe("suppressed");
    expect(calls).toEqual([]);
    dialog.remove();
  });

  it("Space on a focused button belongs to the button, not transport", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const button = el('<button type="button">開く</button>');
    const result = dispatcher.handleKeyDown(key(" ", { target: button }));
    expect(result.kind).toBe("suppressed");
    expect(calls).toEqual([]);
    button.remove();
  });

  it("J on a focused button still dispatches — buttons don't consume J", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    const button = el('<button type="button">開く</button>');
    const result = dispatcher.handleKeyDown(key("j", { target: button }));
    expect(result).toMatchObject({
      kind: "ran",
      commandId: "transport.jumpBack",
    });
    expect(calls).toEqual(["jumpBack"]);
    button.remove();
  });

  it("Space on a radio stays with the control (roving tabindex)", () => {
    const { dispatcher } = setup(WITH_AUDIO);
    const radio = el('<div role="radio" tabindex="0"></div>');
    // Space checks the radio instead of toggling playback.
    expect(
      dispatcher.handleKeyDown(key(" ", { target: radio })).kind,
    ).toBe("suppressed");
    radio.remove();
  });

  it("Ctrl bindings still work from inside a focused control", () => {
    const { dispatcher, calls } = setup(EMPTY);
    const button = el('<button type="button">開く</button>');
    const result = dispatcher.handleKeyDown(
      key("o", { ctrlKey: true, target: button }),
    );
    expect(result).toMatchObject({
      kind: "ran",
      commandId: "file.openAudio",
    });
    expect(calls).toEqual(["openAudio"]);
    button.remove();
  });

  it("allowInTextInput commands still fire inside text fields", () => {
    const { ctx, calls } = mockContext();
    const commands: Command[] = [
      {
        id: "test.inText",
        title: "テスト",
        section: "app",
        shortcuts: ["Ctrl+S"],
        allowInTextInput: true,
        run: () => calls.push("inText"),
      },
    ];
    const dispatcher = new KeyboardDispatcher({
      registry: new CommandRegistry(commands),
      getSnapshot: () => EMPTY,
      context: ctx,
    });
    const input = el('<input type="text">');
    expect(
      dispatcher.handleKeyDown(key("s", { ctrlKey: true, target: input }))
        .kind,
    ).toBe("ran");
    expect(calls).toEqual(["inText"]);
    input.remove();
  });
});

describe("shift-implicit symbol keys (§15 zoom bindings)", () => {
  it('Ctrl+Shift+"+" satisfies the "Ctrl++" binding', () => {
    const { dispatcher, calls } = setup({ ...EMPTY, hasScore: true });
    const result = dispatcher.handleKeyDown(
      key("+", { ctrlKey: true, shiftKey: true }),
    );
    expect(result).toMatchObject({
      kind: "ran",
      commandId: "score.zoomIn",
    });
    expect(calls).toEqual(["zoomScoreIn"]);
  });

  it('Ctrl+"=" satisfies the "Ctrl+=" twin binding', () => {
    const { dispatcher, calls } = setup({ ...EMPTY, hasScore: true });
    expect(
      dispatcher.handleKeyDown(key("=", { ctrlKey: true })).commandId,
    ).toBe("score.zoomIn");
    expect(calls).toEqual(["zoomScoreIn"]);
  });
});

describe("auto-repeat", () => {
  it("does not re-fire non-repeatable commands on held keys", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    dispatcher.handleKeyDown(key(" "));
    const repeat = dispatcher.handleKeyDown(key(" ", { repeat: true }));
    expect(repeat.kind).toBe("repeat");
    expect(repeat.shouldPreventDefault).toBe(true);
    expect(calls).toEqual(["togglePlayPause"]);
  });

  it("J/L allow hold-to-scrub repeats", () => {
    const { dispatcher, calls } = setup(WITH_AUDIO);
    dispatcher.handleKeyDown(key("j"));
    expect(dispatcher.handleKeyDown(key("j", { repeat: true })).kind).toBe(
      "ran",
    );
    expect(calls).toEqual(["jumpBack", "jumpBack"]);
  });
});

describe("multi-chord sequences", () => {
  const seq = (extra: Partial<Command> & { id: string }): Command => ({
    title: "テスト",
    section: "app",
    run: (ctx) => ctx.announce("ran"),
    ...extra,
  });

  function seqDispatcher(now: () => number) {
    const { ctx, calls } = mockContext();
    const dispatcher = new KeyboardDispatcher({
      registry: new CommandRegistry([
        seq({ id: "test.seq", shortcuts: ["Ctrl+K Ctrl+C"] }),
        seq({ id: "test.single", shortcuts: ["Ctrl+U"] }),
      ]),
      getSnapshot: () => EMPTY,
      context: ctx,
      now,
      sequenceTimeoutMs: 1000,
    });
    return { dispatcher, calls };
  }

  it("holds a prefix, then completes the sequence", () => {
    const { dispatcher, calls } = seqDispatcher(() => 0);
    const first = dispatcher.handleKeyDown(key("k", { ctrlKey: true }));
    expect(first).toMatchObject({
      kind: "sequence-pending",
      shouldPreventDefault: true,
    });
    expect(calls).toEqual([]);
    const second = dispatcher.handleKeyDown(key("c", { ctrlKey: true }));
    expect(second).toMatchObject({
      kind: "ran",
      commandId: "test.seq",
    });
    expect(calls).toEqual(["announce"]);
  });

  it("expires a pending prefix after the timeout", () => {
    let t = 0;
    const { dispatcher, calls } = seqDispatcher(() => t);
    dispatcher.handleKeyDown(key("k", { ctrlKey: true }));
    t = 2000; // past the 1000ms window
    const result = dispatcher.handleKeyDown(key("c", { ctrlKey: true }));
    expect(result.kind).toBe("unmatched");
    expect(calls).toEqual([]);
  });

  it("a non-continuing chord drops the prefix and matches standalone", () => {
    const { dispatcher, calls } = seqDispatcher(() => 0);
    dispatcher.handleKeyDown(key("k", { ctrlKey: true }));
    const result = dispatcher.handleKeyDown(key("u", { ctrlKey: true }));
    expect(result).toMatchObject({ kind: "ran", commandId: "test.single" });
    expect(calls).toEqual(["announce"]);
  });
});

describe("region navigation (§22)", () => {
  it("F6 / Shift+F6 dispatch the region-cycling commands", () => {
    const { dispatcher, calls } = setup(EMPTY);
    expect(dispatcher.handleKeyDown(key("F6")).commandId).toBe(
      "nav.nextRegion",
    );
    expect(
      dispatcher.handleKeyDown(key("F6", { shiftKey: true })).commandId,
    ).toBe("nav.previousRegion");
    expect(calls).toEqual(["focusNextRegion", "focusPreviousRegion"]);
  });
});
