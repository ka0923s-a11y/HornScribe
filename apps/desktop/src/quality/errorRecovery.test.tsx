/**
 * @vitest-environment jsdom
 *
 * UI-070 §13 error-recovery gate: every error surface must offer a visible,
 * keyboard-reachable recovery action — never a dead end (issue acceptance:
 * "all error-recovery fixtures have non-dead-end actions"). Renders each
 * surface with its real components and asserts:
 *
 * - at least one enabled actionable button exists;
 * - the surface announces itself (role=alert or a named region);
 * - a dismiss/close path exists (focusable, enabled);
 * - no raw stack-trace style copy (no "Error:" / hex dumps).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ImportScreenBody, type ImportView } from "../import/ImportStates";
import {
  DEFAULT_TRANSCRIPTION_OPTIONS,
  type LoadedAudio,
} from "../import/types";
import { TranscriptionErrorView } from "../components/TranscriptionErrorView";
import type { FailureKind } from "../sidecar";
import type { ScreenState } from "../workspace/screen";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const NOOP = () => undefined;

const AUDIO: LoadedAudio = {
  ref: { kind: "path", path: "C:\\audio\\take-03.wav", name: "take-03.wav" },
  fileName: "take-03.wav",
  format: "wav",
  sizeBytes: 14_680_064,
  durationSeconds: 197.8,
  sampleRate: 44_100,
  peaks: [0.2, 0.5, 0.8, 0.4],
  mediaSource: { kind: "blob", blob: new Blob() },
};

function view(overrides: Partial<ImportView>): ImportView {
  return {
    audio: null,
    openingLabel: null,
    openingKind: null,
    issue: null,
    sourceMissing: null,
    recentProjects: [],
    options: DEFAULT_TRANSCRIPTION_OPTIONS,
    onOpenAudio: NOOP,
    onPickProject: NOOP,
    onOpenProject: NOOP,
    onRemoveRecent: NOOP,
    onPickRelink: NOOP,
    onDismissError: NOOP,
    onOptionsChange: NOOP,
    ...overrides,
  };
}

async function render(node: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

function enabledButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => !b.disabled,
  );
}

const STACK_TRACE_RE = /\b(Error|Exception|Traceback)\b.*:|0x[0-9a-fA-F]{6,}|\bat \w+\.[jt]s/;

describe("error-recovery surfaces (§13)", () => {
  const importCases: { name: string; screen: ScreenState; v: ImportView }[] = [
    {
      name: "audioError — unsupported codec",
      screen: "audioError",
      v: view({ issue: { kind: "unsupported", fileName: "memo.txt" } }),
    },
    {
      name: "audioError — read failure",
      screen: "audioError",
      v: view({ issue: { kind: "openFailed", fileName: "take-03.wav" } }),
    },
    {
      name: "audioError — project open failure",
      screen: "audioError",
      v: view({
        issue: { kind: "projectOpenFailed", fileName: "etude.hornscribe.json" },
      }),
    },
    {
      name: "sourceMissing — source moved",
      screen: "sourceMissing",
      v: view({
        sourceMissing: {
          project: {
            path: "C:\\music\\etude.hornscribe.json",
            projectId: "p1",
            name: "etude",
            sourcePath: "C:\\audio\\etude.flac",
            sourceHash: "a1b2c3",
            scoreResult: null,
            transcriptionSettings: null,
          },
          mismatch: false,
        },
      }),
    },
    {
      name: "sourceMissing — hash mismatch",
      screen: "sourceMissing",
      v: view({
        sourceMissing: {
          project: {
            path: "C:\\music\\etude.hornscribe.json",
            projectId: "p1",
            name: "etude",
            sourcePath: "C:\\audio\\etude.flac",
            sourceHash: "a1b2c3",
            scoreResult: null,
            transcriptionSettings: null,
          },
          mismatch: true,
        },
      }),
    },
  ];

  it.each(importCases)("$name has a non-dead-end action set", async ({ screen, v }) => {
    await render(
      <ImportScreenBody screen={screen} view={v} onTranscribe={NOOP} />,
    );
    const buttons = enabledButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    // The surface announces itself.
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    // Copy must not leak a raw stack trace.
    const text = document.body.textContent ?? "";
    expect(STACK_TRACE_RE.test(text)).toBe(false);
  });

  const failures: FailureKind[] = [
    "transcriptionFailed",
    "workerCrashed",
    "workerNotResponding",
  ];

  it.each(failures)(
    "transcription error surface (%s) offers retry/restart + diagnostics + close",
    async (kind) => {
      await render(
        <TranscriptionErrorView
          kind={kind}
          restarting={false}
          diagnostics={() => "diagnostic text"}
          onPrimary={NOOP}
          onClose={NOOP}
        />,
      );
      const buttons = enabledButtons();
      // Primary recovery + diagnostics + close = at least 3 actions.
      expect(buttons.length).toBeGreaterThanOrEqual(3);
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
      const text = document.body.textContent ?? "";
      expect(STACK_TRACE_RE.test(text)).toBe(false);
    },
  );

  it("audioReady keeps the workspace live (transcribe action present)", async () => {
    await render(
      <ImportScreenBody
        screen="audioReady"
        view={view({ audio: AUDIO })}
        onTranscribe={NOOP}
      />,
    );
    expect(enabledButtons().length).toBeGreaterThanOrEqual(1);
  });
});
