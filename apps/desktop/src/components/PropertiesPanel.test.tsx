// @vitest-environment jsdom
/**
 * #249 tempo-map editor regression tests: mount the real
 * PropertiesPanel with a 3-segment tempo map and exercise every row.
 * Rows render editable, mid-piece marks delete, the add row commits
 * on the FIRST click (the measure SpinButton only reports on blur,
 * which is the same gesture as the click — a disabled button would
 * swallow it), and the ÷2/×2 tempo-octave fixes stay available on
 * multi-segment scores.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PropertiesPanel } from "./PropertiesPanel";
import type {
  NoteInspectorModel,
  ScoreInspectorModel,
} from "../score/inspector";
import { installJsdomStubs } from "../quality/testEnv";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const MODEL: ScoreInspectorModel = {
  kind: "score",
  title: "T",
  composer: null,
  arranger: null,
  tempoLabel: "120 BPM",
  tempoBpm: 120,
  meterLabel: "4/4",
  meterBeats: 4,
  meterUnit: 4,
  pickupBeats: 1,
  pickupBeatsRaw: "1/1",
  pickupLabel: "弱起1拍",
  keyLabel: "ハ長調",
  keyFifths: 0,
  keyMode: "major",
  keyChangeCount: 1,
  keyChanges: [{ measure: 1, fifths: 0, mode: "major" }],
  tempoChanges: [
    { measure: 1, bpm: 120, startBeat: "0/1" },
    { measure: 3, bpm: 96, startBeat: "8/1" },
    { measure: 3, bpm: 88, startBeat: "10/1" },
  ],
  measureCount: 8,
  swingFeel: false,
  measureLabel: "8 小節",
  noteLabel: "10 音",
  openIssueLabel: "0 件",
};

function mount(over: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const props = {
    content: { kind: "none" as const },
    model: MODEL,
    width: 320,
    min: 240,
    max: 480,
    overlay: false,
    onResize: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
    onTempoChange: vi.fn(),
    onTempoScale: vi.fn(),
    onTempoChangeAt: vi.fn(),
    onRemoveTempoChange: vi.fn(),
    ...over,
  };
  act(() => {
    root!.render(<PropertiesPanel {...props} />);
  });
  return props;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("TempoMapEditor (mounted)", () => {
  it("renders one row per mark plus the add row", () => {
    mount();
    const rows = host!.querySelectorAll(".hs-properties__keymap-row");
    expect(rows.length).toBe(3);
    const labels = [...host!.querySelectorAll(
      ".hs-properties__keymap-measure",
    )].map((el) => el.textContent);
    expect(labels).toEqual(["冒頭", "第3小節", "第3小節"]);
  });

  it("mid-piece rows are editable and deletable", () => {
    const props = mount();
    const inputs = host!.querySelectorAll(
      ".hs-properties__keymap-row input",
    );
    expect(inputs.length).toBe(3);
    expect(
      [...inputs].map((i) => (i as HTMLInputElement).disabled),
    ).toEqual([false, false, false]);
    const removeButtons = [...host!.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-label") === "このテンポ変化を削除",
    );
    expect(removeButtons.length).toBe(2);
    act(() => removeButtons[0].click());
    expect(props.onRemoveTempoChange).toHaveBeenCalledWith({
      startBeat: "8/1",
    });
  });

  it("keeps the tempo-octave quick fixes available", () => {
    const props = mount();
    const texts = [...host!.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(texts).toContain("÷2");
    expect(texts).toContain("×2");
    const halve = [...host!.querySelectorAll("button")].find(
      (b) => b.textContent === "÷2",
    )!;
    act(() => halve.click());
    expect(props.onTempoScale).toHaveBeenCalledWith(0.5);
  });

  it("add row commits a barline mark on the first click", () => {
    const props = mount();
    const addInputs = host!.querySelectorAll(
      ".hs-properties__keymap-add input",
    );
    const measureInput = addInputs[0] as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(measureInput, "5");
      measureInput.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
      measureInput.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      );
    });
    const addButton = [...host!.querySelectorAll("button")].find(
      (b) => b.textContent === "テンポ変化を追加",
    )!;
    // Regression: the button must not be disabled before the click —
    // the blur-commit and the click are one user gesture.
    expect(addButton.disabled).toBe(false);
    act(() => addButton.click());
    expect(props.onTempoChangeAt).toHaveBeenCalledWith({
      bpm: 120,
      startMeasure: 5,
    });
  });

  it("add row flags an empty measure instead of a dead button", () => {
    mount();
    const addButton = [...host!.querySelectorAll("button")].find(
      (b) => b.textContent === "テンポ変化を追加",
    )!;
    act(() => addButton.click());
    expect(
      host!.querySelector(".hs-properties__keymap-add .fui-Field")
        ?.textContent,
    ).toContain("追加先の小節を入力してください");
  });

  it("editing the head row commits at beat 0", () => {
    const props = mount();
    const headInput = host!.querySelector(
      ".hs-properties__keymap-row input",
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(headInput, "140");
      headInput.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
      headInput.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      );
    });
    expect(props.onTempoChangeAt).toHaveBeenCalledTimes(1);
    expect(props.onTempoChangeAt).toHaveBeenCalledWith({
      bpm: 140,
      startBeat: "0/1",
    });
  });
});

describe("PickupField (mounted)", () => {
  const pickupSelect = (): HTMLSelectElement => {
    const sel = [...host!.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "1/1"),
    );
    expect(sel).toBeDefined();
    return sel as HTMLSelectElement;
  };

  // #358: every integer beat that fits the measure plus the common
  // half-beat pickup — ordered by position inside the bar.
  it("lists 弱起なし, half-beat, then integer beats", () => {
    mount({ onPickupChange: vi.fn() });
    const sel = pickupSelect();
    const values = [...sel.options].map((o) => o.value);
    expect(values).toEqual(["0/1", "1/2", "1/1", "2/1", "3/1"]);
    expect(sel.value).toBe("1/1");
    const labels = [...sel.options].map((o) => o.textContent);
    expect(labels[0]).toBe("弱起なし");
    expect(labels).toContain("弱起1拍");
  });

  it("commits the picked fraction to onPickupChange", () => {
    const onPickupChange = vi.fn();
    mount({ onPickupChange });
    const sel = pickupSelect();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(sel, "0/1");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPickupChange).toHaveBeenCalledWith("0/1");
  });

  it("keeps an unusual current value selectable", () => {
    mount({
      onPickupChange: vi.fn(),
      model: {
        ...MODEL,
        pickupBeats: 1.5,
        pickupBeatsRaw: "3/2",
        pickupLabel: "弱起3/2拍",
      },
    });
    const sel = pickupSelect();
    expect(sel.options[0].value).toBe("3/2");
    expect(sel.value).toBe("3/2");
  });

  it("falls back to the summary row without an edit channel", () => {
    mount();
    const rows = [...host!.querySelectorAll(".hs-properties__rows *")]
      .map((el) => el.textContent);
    expect(rows).toContain("弱起");
    expect(rows).toContain("弱起1拍");
  });
});

/* #379: the note body is an editable inspector — the buttons run the
 *  same score-workspace commands as the keyboard shortcuts. */
const NOTE_MODEL: NoteInspectorModel = {
  kind: "note",
  canonicalId: "sn-000001",
  measure: 1,
  concertPitch: "C4",
  writtenPitch: "G3",
  durationLabel: "四分音符",
  onsetLabel: "第1小節",
  tieLabel: null,
  issues: [],
};

function noteActionSpies() {
  return {
    pitch: vi.fn(),
    toggleEnharmonic: vi.fn(),
    toggleDeleted: vi.fn(),
    durationScale: vi.fn(),
    shiftOnset: vi.fn(),
    toggleTie: vi.fn(),
    split: vi.fn(),
    merge: vi.fn(),
    restToNote: vi.fn(),
  };
}

function editButton(label: string): HTMLButtonElement {
  return [...host!.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
}

describe("NoteBody edit controls (#379)", () => {
  it("renders labelled edit groups that invoke the shared commands", () => {
    const noteActions = noteActionSpies();
    mount({ model: NOTE_MODEL, noteActions });
    const labels = [
      ...host!.querySelectorAll(".hs-properties__editlabel"),
    ].map((el) => el.textContent);
    expect(labels).toEqual(["音高", "音の長さ", "開始位置", "操作"]);

    act(() => editButton("＋半音").click());
    expect(noteActions.pitch).toHaveBeenCalledWith(1);
    act(() => editButton("−半音").click());
    expect(noteActions.pitch).toHaveBeenCalledWith(-1);
    act(() => editButton("異名同音").click());
    expect(noteActions.toggleEnharmonic).toHaveBeenCalled();
    act(() => editButton("短く").click());
    expect(noteActions.durationScale).toHaveBeenCalledWith(-1);
    act(() => editButton("長く").click());
    expect(noteActions.durationScale).toHaveBeenCalledWith(1);
    act(() => editButton("前へ").click());
    expect(noteActions.shiftOnset).toHaveBeenCalledWith(-1);
    act(() => editButton("後へ").click());
    expect(noteActions.shiftOnset).toHaveBeenCalledWith(1);
    act(() => editButton("タイ").click());
    expect(noteActions.toggleTie).toHaveBeenCalled();
    act(() => editButton("分割").click());
    expect(noteActions.split).toHaveBeenCalled();
    act(() => editButton("結合").click());
    expect(noteActions.merge).toHaveBeenCalled();
    act(() => editButton("削除 / 復元").click());
    expect(noteActions.toggleDeleted).toHaveBeenCalled();
  });

  it("engine-off edits stay visible, disabled, and self-explaining", () => {
    mount({
      model: NOTE_MODEL,
      noteActions: noteActionSpies(),
      noteEngineEdits: false,
    });
    // Engine edits (duration/onset/tie/split/merge) are aria-disabled
    // but keep hover/focus so the tooltip can say why.
    for (const label of ["短く", "長く", "前へ", "後へ", "タイ", "分割", "結合"]) {
      const b = editButton(label);
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
    // Overlay edits (pitch/enharmonic/delete) work on any document.
    for (const label of ["−半音", "＋半音", "異名同音", "削除 / 復元"]) {
      const b = editButton(label);
      expect(b.getAttribute("aria-disabled")).not.toBe("true");
      expect(b.disabled).toBe(false);
    }
    expect(host!.textContent).toContain(
      "採譜エンジン接続時に利用できます",
    );
  });

  it("a rest selection offers only the convert action", () => {
    const noteActions = noteActionSpies();
    mount({
      model: { ...NOTE_MODEL, canonicalId: null },
      noteActions,
    });
    expect(editButton("音符に変換")).toBeTruthy();
    expect(editButton("＋半音")).toBeUndefined();
    act(() => editButton("音符に変換").click());
    expect(noteActions.restToNote).toHaveBeenCalled();
  });
});
