// @vitest-environment jsdom
/**
 * #385: the transcribing screen must never show fabricated percents —
 * stage boundaries alone leave the bar indeterminate, counted work
 * units render as real step counts, and a percent appears only for a
 * genuine whole-job fraction.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJobView,
  reduceJobEvent,
  type JobView,
} from "../sidecar/jobView";
import type { JobEventPayload } from "../sidecar/protocol";
import type { CommandSurface } from "../commands/registry";
import { TranscriptionView } from "./TranscriptionView";
import { installJsdomStubs } from "../quality/testEnv";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const commands: CommandSurface = {
  invoke: vi.fn(() => true),
  isEnabled: () => true,
  isVisible: () => true,
  title: (id) => id,
  shortcutLabel: () => undefined,
};

function ev(over: Partial<JobEventPayload>): JobEventPayload {
  return { jobId: "job-1", phase: "progress", ...over };
}

function render(job: JobView | null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TranscriptionView job={job} commands={commands} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function progressBar(): HTMLElement | null {
  return host?.querySelector('[role="progressbar"]') ?? null;
}

describe("TranscriptionView progress honesty (#385)", () => {
  it("stage boundary alone stays indeterminate — no fabricated %", () => {
    let job = createJobView("job-1", "transcription", 0);
    job = reduceJobEvent(job, ev({ stage: "transcribing" }));
    render(job);
    const bar = progressBar();
    expect(bar).not.toBeNull();
    // Indeterminate: no aria-valuenow at all.
    expect(bar?.getAttribute("aria-valuenow")).toBeNull();
    // No percent text and no step text anywhere.
    expect(host?.textContent).not.toMatch(/\d+%/);
    expect(host?.textContent).not.toMatch(/\d+\/\d+/);
  });

  it("counted stage units render as real step counts + determinate bar", () => {
    let job = createJobView("job-1", "transcription", 0);
    job = reduceJobEvent(job, ev({ stage: "rendering" }));
    job = reduceJobEvent(
      job,
      ev({ stage: "rendering", step: 2, totalSteps: 5 }),
    );
    render(job);
    const bar = progressBar();
    expect(bar?.getAttribute("aria-valuenow")).toBe("0.4");
    expect(host?.textContent).toContain("2/5");
    // A step count is never presented as a percentage.
    expect(host?.textContent).not.toMatch(/\d+%/);
  });

  it("a genuine whole-job fraction shows the percent", () => {
    let job = createJobView("job-1", "demoLongTask", 0);
    job = reduceJobEvent(job, ev({ progress: 0.42 }));
    render(job);
    const bar = progressBar();
    expect(bar?.getAttribute("aria-valuenow")).toBe("0.42");
    expect(host?.textContent).toContain("42%");
  });

  it("null job renders the same indeterminate shell", () => {
    render(null);
    expect(progressBar()?.getAttribute("aria-valuenow")).toBeNull();
  });
});
