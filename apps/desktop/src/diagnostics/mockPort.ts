/**
 * MockDiagnosticsPort — populated diagnostics data so the §19 surface is
 * fully exercisable in `vite dev` / vitest without an engine.
 *
 * Fields the real bridge cannot know yet (Verovio / wavesurfer versions)
 * report "unknown" honestly rather than fabricated numbers.
 *
 * Dev override: localStorage["hornscribe.dev.museScore"] === "missing"
 * makes MuseScore report missing (same flag the export mock honors, so the
 * tools section, the diagnostics sheet and the export dialog agree).
 */

import { getShellInfo } from "../tauri/bridge";
import type { TimingCorrection } from "../sidecar/resultMeta";
import {
  withPathOverride,
  type DiagnosticsInfo,
  type ToolInfo,
  type ToolPathOverrides,
} from "./types";
import { clipboardWrite, type DiagnosticsPort } from "./port";

const DEV_MUSESCORE_KEY = "hornscribe.dev.museScore";

export interface MockDiagnosticsPortOptions {
  museScore?: ToolInfo;
  ffmpeg?: ToolInfo;
  demucs?: ToolInfo;
  latencyMs?: number;
  /** `undefined` → a sample applied correction exercises the row;
   *  `null` → the sheet's silent state (no correction reported). */
  timingCorrection?: TimingCorrection | null;
}

export class MockDiagnosticsPort implements DiagnosticsPort {
  private readonly options: MockDiagnosticsPortOptions;

  constructor(options: MockDiagnosticsPortOptions = {}) {
    this.options = options;
  }

  static withDevOverrides(): MockDiagnosticsPort {
    let museScore: ToolInfo | undefined;
    try {
      if (window.localStorage.getItem(DEV_MUSESCORE_KEY) === "missing") {
        museScore = { status: "missing" };
      }
    } catch {
      /* defaults are fine */
    }
    return new MockDiagnosticsPort({ museScore });
  }

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.options.latencyMs ?? 200));
  }

  async collect(overrides?: ToolPathOverrides): Promise<DiagnosticsInfo> {
    await this.delay();
    const shell = await getShellInfo().catch(() => null);
    const museScore =
      this.options.museScore ??
      ({
        status: "found",
        path: "C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe",
        version: "4.x",
      } satisfies ToolInfo);
    const ffmpeg =
      this.options.ffmpeg ??
      ({
        status: "found",
        path: "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
        version: "7.x",
      } satisfies ToolInfo);
    return {
      appVersion: shell?.version ?? "0.1.0 (dev)",
      engine: {
        name: "hornscribe-engine (mock)",
        version: "0.1.0",
        python: "3.12.x",
        platform: "win32",
      },
      protocolVersion: 1,
      backend: "basic-pitch (mock)",
      tools: {
        ffmpeg: withPathOverride(ffmpeg, overrides?.ffmpegPath),
        museScore: withPathOverride(museScore, overrides?.museScorePath),
        // Mock engine advertises demucs so the review surface shows
        // the separation row in its working state.
        demucs: this.options.demucs ?? { status: "found" },
        // Frontend libs are not integrated yet — honest "unknown".
        verovio: { status: "unknown" },
        wavesurfer: { status: "unknown" },
      },
      paths: {
        cache: "C:\\Users\\user\\AppData\\Local\\HornScribe\\cache",
        logs: "C:\\Users\\user\\AppData\\Local\\HornScribe\\logs",
      },
      workerStatus: "running",
      timingCorrection:
        this.options.timingCorrection === undefined
          ? { shiftSec: 0.017, meterResolved: true }
          : this.options.timingCorrection,
    };
  }

  async copyText(text: string): Promise<boolean> {
    return clipboardWrite(text);
  }

  async openLogFolder(): Promise<boolean> {
    // Browsers cannot reveal OS folders — honest false; the sheet
    // announces the failure instead of pretending something opened.
    return false;
  }

  async restartEngine(): Promise<boolean> {
    await this.delay();
    return true; // the in-process mock "engine" always comes back
  }
}
