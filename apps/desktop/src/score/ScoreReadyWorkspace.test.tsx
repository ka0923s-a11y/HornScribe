// @vitest-environment jsdom
// #401: renderer init failure must render the fixed Japanese surface
// (title / body / recovery actions) and keep the raw exception behind
// the 診断情報 dialog — never in the visible copy (GUI_UX_SPEC §20,
// JAPANESE_UI_COPY §7).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import { createFixtureScoreDocument } from "./fixtureDocument";

const rendererMock = vi.hoisted(() => ({
  getScoreRenderer: vi.fn(),
}));

vi.mock("./verovio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./verovio")>()),
  getScoreRenderer: rendererMock.getScoreRenderer,
}));

import { ScoreReadyWorkspace } from "./ScoreReadyWorkspace";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

const NOOP = () => undefined;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ScoreReadyWorkspace
        document={createFixtureScoreDocument()}
        pitch="concert"
        onInspectorChange={NOOP}
        announce={NOOP}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("ScoreReadyWorkspace init-failure surface (#401)", () => {
  it("shows fixed Japanese copy, never the raw exception", async () => {
    rendererMock.getScoreRenderer.mockRejectedValue(
      new Error("WebAssembly.instantiate(): magic word mismatch"),
    );
    await mount();

    const surface = host!.querySelector(".hs-score-error");
    expect(surface).not.toBeNull();
    expect(surface!.querySelector("h2")!.textContent).toBe(
      ja.scoreView.initErrorTitle,
    );
    expect(surface!.textContent).toContain(ja.scoreView.initErrorBody);
    expect(surface!.textContent).not.toContain("magic word");
    expect(surface!.textContent).not.toContain("WebAssembly");

    const labels = [...surface!.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).toContain(ja.common.retry);
    expect(labels).toContain(ja.common.diagnostics);
  });

  it("keeps the raw exception inside the 診断情報 dialog", async () => {
    rendererMock.getScoreRenderer.mockRejectedValue(
      new Error("WASM trap: unreachable executed"),
    );
    await mount();

    const diagButton = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === ja.common.diagnostics,
    )!;
    await act(async () => {
      diagButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    const pre = document.querySelector(".hs-diagnostics");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("unreachable executed");
    expect(pre!.textContent).toContain("rev-fixture0000001");
  });

  it("再試行 runs a fresh init attempt and re-shows the surface on repeat failure", async () => {
    rendererMock.getScoreRenderer.mockRejectedValue(
      new Error("WASM init exploded"),
    );
    await mount();
    expect(rendererMock.getScoreRenderer).toHaveBeenCalledTimes(1);

    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === ja.common.retry,
    )!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(rendererMock.getScoreRenderer).toHaveBeenCalledTimes(2);
    const surface = host!.querySelector(".hs-score-error");
    expect(surface).not.toBeNull();
    expect(surface!.querySelector("h2")!.textContent).toBe(
      ja.scoreView.initErrorTitle,
    );
  });
});