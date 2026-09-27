// @vitest-environment jsdom
/**
 * #376: review-issue markers on the waveform strip — clustered ticks
 * that jump to the issue via the shared review cursor. Covers the
 * cluster math (gap merge, severity priority, out-of-view drop) and
 * the mounted listbox (click + Enter jump, option naming).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import {
  clusterMarkers,
  WaveformView,
  type WaveformMarker,
} from "./WaveformView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const VIEW = { startSec: 0, endSec: 100 };

function marker(
  index: number,
  startSec: number,
  severity: WaveformMarker["severity"] = "caution",
): WaveformMarker {
  return { index, startSec, severity, label: "issue " + index };
}

describe("clusterMarkers (#376)", () => {
  it("merges markers closer than the gap ratio", () => {
    const out = clusterMarkers(
      [marker(0, 10), marker(1, 10.5), marker(2, 30)],
      VIEW,
      0.012,
    );
    expect(out).toHaveLength(2);
    expect(out[0].items.map((m) => m.index)).toEqual([0, 1]);
    expect(out[1].items.map((m) => m.index)).toEqual([2]);
  });

  it("keeps the highest severity in a cluster", () => {
    const out = clusterMarkers(
      [marker(0, 10, "info"), marker(1, 10.4, "warning")],
      VIEW,
      0.012,
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].label).toContain("2");
  });

  it("drops markers outside the view window", () => {
    const out = clusterMarkers(
      [marker(0, 10), marker(1, 250)],
      VIEW,
      0.012,
    );
    expect(out).toHaveLength(1);
    expect(out[0].items[0].index).toBe(0);
  });

  it("zoomed views position markers inside the window", () => {
    const out = clusterMarkers(
      [marker(0, 55)],
      { startSec: 50, endSec: 60 },
      0.012,
    );
    expect(out).toHaveLength(1);
    expect(out[0].pos).toBeCloseTo(0.5);
  });
});

const AUDIO = {
  fileName: "take.wav",
  durationSeconds: 120,
  peaks: [0.2, 0.6, 0.4, 0.8, 0.3],
};

async function mount(extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const props = {
    height: 96,
    min: 64,
    max: 240,
    onResize: vi.fn(),
    onReset: vi.fn(),
    audio: AUDIO,
    ...extra,
  };
  await act(async () => {
    root!.render(<WaveformView {...props} />);
  });
  return props;
}

function markerEls(): HTMLElement[] {
  return [
    ...document.querySelectorAll('[role="option"].hs-waveform__marker'),
  ] as HTMLElement[];
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

describe("WaveformView review markers (#376)", () => {
  it("renders one option per clustered marker with its label", async () => {
    await mount({
      markers: [
        marker(0, 30, "warning"),
        marker(4, 60, "info"),
        marker(7, 200), // beyond duration — filtered out
      ],
    });
    const els = markerEls();
    expect(els).toHaveLength(2);
    expect(els[0].className).toContain("hs-waveform__marker--warning");
    expect(els[1].className).toContain("hs-waveform__marker--info");
    expect(els[0].getAttribute("aria-label")).toBe("issue 0");
  });

  it("click jumps to the marker's issue index", async () => {
    const onMarkerClick = vi.fn();
    await mount({
      markers: [marker(0, 30), marker(4, 60)],
      onMarkerClick,
    });
    await act(async () => {
      markerEls()[1].dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onMarkerClick).toHaveBeenCalledWith(4);
  });

  it("listbox keys move active option, Enter jumps", async () => {
    const onMarkerClick = vi.fn();
    await mount({
      markers: [marker(0, 30), marker(4, 60), marker(8, 90)],
      onMarkerClick,
    });
    const list = document.querySelector<HTMLElement>(
      ".hs-waveform__markers",
    )!;
    await key(list, "ArrowRight");
    expect(list.getAttribute("aria-activedescendant")).toBe(
      "hs-wavemarker-0",
    );
    await key(list, "ArrowRight");
    await key(list, "Enter");
    expect(onMarkerClick).toHaveBeenCalledWith(4);
  });

  it("a dense cluster renders once and jumps to its first issue", async () => {
    const onMarkerClick = vi.fn();
    await mount({
      markers: [marker(2, 30), marker(5, 30.2), marker(9, 30.4)],
      onMarkerClick,
    });
    const els = markerEls();
    expect(els).toHaveLength(1);
    expect(els[0].textContent).toContain("3");
    await act(async () => {
      els[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onMarkerClick).toHaveBeenCalledWith(2);
  });

  it("no markers prop renders no listbox", async () => {
    await mount({});
    expect(
      document.querySelector(".hs-waveform__markers"),
    ).toBeNull();
  });
});

describe("WaveformView note overlay (#402)", () => {
  const NOTES = [
    { id: "sn-1", startSec: 10, endSec: 12, midi: 60, partIndex: 0 },
    { id: "sn-2", startSec: 12, endSec: 13.5, midi: 64, partIndex: 0 },
    { id: "sn-3", startSec: 12, endSec: 14, midi: 55, partIndex: 1 },
  ];

  it("renders one bar per in-view note, second voice marked", async () => {
    await mount({ overlayNotes: NOTES });
    const bars = [
      ...document.querySelectorAll(".hs-waveform__note"),
    ] as HTMLElement[];
    expect(bars).toHaveLength(3);
    // 120s clip, full view: 10s in = 8.33%
    expect(parseFloat(bars[0].style.left)).toBeCloseTo((10 / 120) * 100, 3);
    // midi window 55..64 padded to 53..66 -> lane = (66-60)/13 ≈ 46.2%
    expect(parseFloat(bars[0].style.top)).toBeCloseTo(600 / 13, 1);
    expect(bars[1].className).not.toContain("extra");
    expect(bars[2].className).toContain("hs-waveform__note--extra");
  });

  it("toggle hides and re-shows the lane layer", async () => {
    await mount({ overlayNotes: NOTES });
    const btn = document.querySelector(
      ".hs-waveform__notes-toggle",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelectorAll(".hs-waveform__note")).toHaveLength(0);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelectorAll(".hs-waveform__note")).toHaveLength(3);
  });

  it("shows no toggle when there is nothing to overlay", async () => {
    await mount({});
    expect(
      document.querySelector(".hs-waveform__notes-toggle"),
    ).toBeNull();
    await mount({ overlayNotes: [] });
    expect(
      document.querySelector(".hs-waveform__notes-toggle"),
    ).toBeNull();
  });

  it("draws one f0 polyline per note, bends sitting below the lane (#427)", async () => {
    await mount({
      overlayNotes: [
        {
          id: "sn-1",
          startSec: 10,
          endSec: 12,
          midi: 60,
          partIndex: 0,
          bends: [
            { pos: 0, semis: -1 },
            { pos: 1, semis: -1 },
          ],
        },
        { id: "sn-2", startSec: 12, endSec: 13.5, midi: 64, partIndex: 0 },
        { id: "sn-3", startSec: 12, endSec: 14, midi: 55, partIndex: 1 },
      ],
    });
    const lines = document.querySelectorAll(".hs-waveform__f0-line");
    expect(lines).toHaveLength(3);
    // A -1st bend drops the contour below the lane midline (larger y
    // fraction = lower on screen).
    const y = parseFloat(
      lines[0].getAttribute("points")!.split(" ")[0].split(",")[1],
    );
    const lane = document.querySelector<HTMLElement>(".hs-waveform__note")!;
    const laneMid =
      (parseFloat(lane.style.top) + parseFloat(lane.style.height) / 2) / 100;
    expect(y).toBeGreaterThan(laneMid);
    expect(lines[2].getAttribute("class")).toContain("--extra");
  });
});

describe("WaveformView retranscribe-selection action (#57)", () => {
  const RANGE = { startSec: 10, endSec: 30 };

  function retranscribeBtn(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>("button")].find(
      (b) => b.getAttribute("aria-label") === ja.waveform.retranscribeSelection,
    );
  }

  it("renders the action on a committed selection and fires with the range", async () => {
    const onRetranscribeSelection = vi.fn();
    await mount({
      selection: RANGE,
      onSelect: vi.fn(),
      onRetranscribeSelection,
    });
    const btn = retranscribeBtn();
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
    expect(onRetranscribeSelection).toHaveBeenCalledWith(RANGE);
  });

  it("stays absent when the caller does not provide the callback", async () => {
    await mount({ selection: RANGE, onSelect: vi.fn() });
    // The other committed-selection actions still render — only the
    // retranscribe affordance is gated on the prop.
    expect(retranscribeBtn()).toBeUndefined();
    expect(
      [...document.querySelectorAll<HTMLElement>("button")].some(
        (b) => b.getAttribute("aria-label") === ja.waveform.loopSelection,
      ),
    ).toBe(true);
  });
});
