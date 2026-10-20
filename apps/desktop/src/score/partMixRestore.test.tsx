// @vitest-environment jsdom
// #416: a project's saved uiSession.partMix must seed the mixer on
// mount (index merge over canonical parts) and report the restored
// rows once via onPartMixRestored — the App-level dirty baseline.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { XmlScoreDocument } from "./xmlDocument";
import type { PartMixEntry } from "./playbackSynth";
import type { ScoreWorkspaceState } from "./controller";
import concertXml from "./fixtures/score_concert.musicxml?raw";
import hornXml from "./fixtures/score_horn_in_f.musicxml?raw";

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

const RENDERER_STUB = {
  version: "test",
  load: () => true,
  setZoom: () => undefined,
  getZoom: () => 100,
  setViewMode: () => undefined,
  getViewMode: () => "continuous" as const,
  pageCount: () => 1,
  renderPage: () => "<svg><g/></svg>",
  renderAllPages: () => [{ page: 1, svg: "<svg><g/></svg>" }],
  timemap: () => [],
  durationMs: () => 0,
  timeForElement: () => null,
  timesForElement: () => null,
  elementsAtTime: () => null,
  pageWithElement: () => 0,
};

// 2 パートの canonical — Horn in F(移調)と Piano(伴奏)。
const CANONICAL = {
  schemaVersion: 1,
  content: {
    parts: [
      { name: "Horn in F", notes: [{ id: "n1" }] },
      { name: "Piano", transposing: false, notes: [{ id: "n2" }] },
    ],
  },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(opts: {
  initialPartMix?: readonly PartMixEntry[] | null;
  onPartMixRestored?: (rows: readonly PartMixEntry[]) => void;
}): Promise<ScoreWorkspaceState[]> {
  const doc = new XmlScoreDocument({
    concertXml,
    hornXml,
    revisionId: "rev-test-1",
    issues: [],
    canonicalDocument: CANONICAL,
  });
  const states: ScoreWorkspaceState[] = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ScoreReadyWorkspace
        document={doc}
        pitch="concert"
        onInspectorChange={NOOP}
        announce={NOOP}
        onStateChange={(s) => states.push(s)}
        initialPartMix={opts.initialPartMix}
        onPartMixRestored={opts.onPartMixRestored}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  return states;
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

describe("ScoreReadyWorkspace partMix restore (#416)", () => {
  it("seeds the mixer from initialPartMix and reports the restored rows", async () => {
    rendererMock.getScoreRenderer.mockResolvedValue(RENDERER_STUB);
    const restored: readonly PartMixEntry[][] = [];
    const saved: PartMixEntry[] = [
      // 保存行は canonical 順の index 結合 — name は canonical 側が勝つ。
      { name: "saved horn", volume: 0.4, muted: true, solo: false, visible: false },
    ];
    const states = await mount({
      initialPartMix: saved,
      onPartMixRestored: (rows) => restored.push(rows),
    });
    // 一度だけ、復元結果の実値を報告する。
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual([
      { name: "Horn in F", volume: 0.4, muted: true, solo: false, visible: false },
      // 保存行が足りない index は既定(伴奏=0.7)。
      { name: "Piano", volume: 0.7, muted: false, solo: false, visible: true },
    ]);
    // push されるミキサー状態も復元結果を反映する。
    const last = states[states.length - 1];
    expect(last.partMix).toEqual(restored[0]);
  });

  it("without initialPartMix every row is a default", async () => {
    rendererMock.getScoreRenderer.mockResolvedValue(RENDERER_STUB);
    const restored: readonly PartMixEntry[][] = [];
    const states = await mount({
      onPartMixRestored: (rows) => restored.push(rows),
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual([
      { name: "Horn in F", volume: 1, muted: false, solo: false, visible: true },
      { name: "Piano", volume: 0.7, muted: false, solo: false, visible: true },
    ]);
    const last = states[states.length - 1];
    expect(last.partMix).toEqual(restored[0]);
  });
});

