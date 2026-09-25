// @vitest-environment jsdom
// #399: a queued engine edit is unsaved work from enqueue — the
// workspace mirrors pendingEdits in ScoreWorkspaceState, and
// waitForPendingEdits lets a snapshotter (Ctrl+S) wait out the
// serialized queue so edit→save lands in the user's order.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import { XmlScoreDocument } from "./xmlDocument";
import type { ScoreWorkspaceController, ScoreWorkspaceState } from "./controller";
import type { ScoreEditResult } from "./rhythmEdits";
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

function editResult(revision: string): ScoreEditResult {
  return {
    scoreDocument: { schemaVersion: 1, notes: [] },
    scoreRevision: revision,
    musicXmlConcert: concertXml,
    musicXmlHornF: hornXml,
  };
}

interface MountOut {
  readonly doc: XmlScoreDocument;
  readonly states: ScoreWorkspaceState[];
  readonly controller: { current: ScoreWorkspaceController | null };
}

async function mount(
  onRhythmEdit: (doc: unknown, op: unknown) => Promise<ScoreEditResult>,
): Promise<MountOut> {
  const doc = new XmlScoreDocument({
    concertXml,
    hornXml,
    revisionId: "rev-test-1",
    issues: [],
    canonicalDocument: { schemaVersion: 1, notes: [] },
  });
  const states: ScoreWorkspaceState[] = [];
  const controller = { current: null as ScoreWorkspaceController | null };
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
        controllerRef={(c) => {
          controller.current = c;
        }}
        onStateChange={(s) => states.push(s)}
        onRhythmEdit={onRhythmEdit}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  return { doc, states, controller };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

const lastPending = (states: ScoreWorkspaceState[]) =>
  states.length === 0 ? 0 : states[states.length - 1].pendingEdits;

describe("ScoreReadyWorkspace pending engine edits (#399)", () => {
  it("pendingEdits is 1 while the engine call is in flight, 0 after", async () => {
    rendererMock.getScoreRenderer.mockResolvedValue(RENDERER_STUB);
    let release!: (r: ScoreEditResult) => void;
    const gate = new Promise<ScoreEditResult>((res) => {
      release = res;
    });
    const onRhythmEdit = vi.fn(() => gate);
    const { states, controller, doc } = await mount(onRhythmEdit);

    await act(async () => {
      controller.current!.requantize!({ divisions: 16 });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onRhythmEdit).toHaveBeenCalledTimes(1);
    expect(lastPending(states)).toBe(1);

    await act(async () => {
      release(editResult("rev-test-2"));
      await controller.current!.waitForPendingEdits!();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(lastPending(states)).toBe(0);
    // The committed content actually landed on the document.
    expect(doc.revisionId).toBe("rev-test-2");
  });

  it("waitForPendingEdits covers every queued edit, in order", async () => {
    rendererMock.getScoreRenderer.mockResolvedValue(RENDERER_STUB);
    const releases: Array<(r: ScoreEditResult) => void> = [];
    const onRhythmEdit = vi.fn(
      () =>
        new Promise<ScoreEditResult>((res) => {
          releases.push(res);
        }),
    );
    const { controller, doc } = await mount(onRhythmEdit);

    await act(async () => {
      controller.current!.requantize!({ divisions: 16 });
      controller.current!.requantize!({ divisions: 32 });
      await new Promise((r) => setTimeout(r, 10));
    });
    // Serialized queue: only the first edit has reached the engine.
    expect(onRhythmEdit).toHaveBeenCalledTimes(1);

    await act(async () => {
      releases[0](editResult("rev-a"));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onRhythmEdit).toHaveBeenCalledTimes(2);

    await act(async () => {
      releases[1](editResult("rev-b"));
      await controller.current!.waitForPendingEdits!();
    });
    expect(doc.revisionId).toBe("rev-b");
  });

  it("a rejected edit releases pending and keeps the old document", async () => {
    rendererMock.getScoreRenderer.mockResolvedValue(RENDERER_STUB);
    let reject!: (e: unknown) => void;
    const gate = new Promise<ScoreEditResult>((_res, rej) => {
      reject = rej;
    });
    const announcements: string[] = [];
    const doc = new XmlScoreDocument({
      concertXml,
      hornXml,
      revisionId: "rev-keep",
      issues: [],
      canonicalDocument: { schemaVersion: 1, notes: [] },
    });
    const states: ScoreWorkspaceState[] = [];
    const controller = { current: null as ScoreWorkspaceController | null };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ScoreReadyWorkspace
          document={doc}
          pitch="concert"
          onInspectorChange={NOOP}
          announce={(m) => announcements.push(m)}
          controllerRef={(c) => {
            controller.current = c;
          }}
          onStateChange={(s) => states.push(s)}
          onRhythmEdit={() => gate}
        />,
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      controller.current!.requantize!({ divisions: 16 });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(lastPending(states)).toBe(1);

    await act(async () => {
      reject(new Error("engine exploded"));
      await controller.current!.waitForPendingEdits!();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(lastPending(states)).toBe(0);
    expect(doc.revisionId).toBe("rev-keep");
    expect(announcements).toContain(ja.commandFeedback.rhythmEditFailed);
  });
});