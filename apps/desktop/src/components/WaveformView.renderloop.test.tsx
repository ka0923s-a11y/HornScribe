// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { WaveformView } from "./WaveformView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

describe("WaveformView render stability", () => {
  it("does not render-loop on audio mount", async () => {
    let renders = 0;
    const origDebug = console.debug;
    console.debug = (...a: unknown[]) => { renders += 1; origDebug(...a); };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const audio = { fileName: "x.wav", durationSeconds: 5, peaks: [0.2, 0.5] };
    await act(async () => {
      root.render(<WaveformView height={96} min={64} max={240} onResize={() => {}} onReset={() => {}} audio={audio} />);
    });
    console.debug = origDebug;
    const ve = host.querySelector(".hs-waveform")?.getAttribute("data-view-end");
    expect(ve).toBe("5");
    expect(renders).toBeLessThan(20);
    root.unmount();
  });
});
