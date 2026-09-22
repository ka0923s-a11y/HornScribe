/**
 * MockExportPort — in-process emulation of the export backend so the §17
 * flow (formats, MuseScore gating, destination, progress, done/error
 * recovery) is exercisable in `vite dev` and vitest without a real engine.
 *
 * The fake reports an engine identity honestly labelled "(mock)" — the
 * diagnostics surface never pretends a real engine answered.
 *
 * Dev overrides (browser only, read once at construction):
 *   localStorage["hornscribe.dev.museScore"] === "missing"  → MuseScore
 *     reports missing so the PDF-disabled recovery path is reviewable;
 *   localStorage["hornscribe.dev.exportFailure"] in
 *     {"permission","engine","musescore","failed"}          → export()
 *     always rejects with the matching ExportError code so the error
 *     phases are reachable from the UI.
 */

import {
  withPathOverride,
  type EngineInfo,
  type ToolInfo,
  type ToolPathOverrides,
} from "../diagnostics/types";
import {
  ExportError,
  EXPORT_FORMAT_IDS,
  type ExportCapabilities,
  type ExportErrorCode,
  type ExportFormatId,
  type ExportPort,
  type ExportRequest,
  type ExportResult,
} from "./types";
import type { ExportedFile } from "./types";

/** ENG-001 filename policy: `<basename>_<artifact>`. */
const ARTIFACT_NAMES: Record<ExportFormatId, string> = {
  concertMusicxml: "concert.musicxml",
  hornMusicxml: "horn_in_f.musicxml",
  concertPdf: "concert.pdf",
  hornPdf: "horn_in_f.pdf",
  playbackMidi: "playback.mid",
};

const MOCK_ENGINE: EngineInfo = {
  name: "hornscribe-engine (mock)",
  version: "0.1.0",
  python: "3.12.x",
  platform: "win32",
};

const DEV_MUSESCORE_KEY = "hornscribe.dev.museScore";
const DEV_FAILURE_KEY = "hornscribe.dev.exportFailure";

const DEV_FAILURE_CODES: Record<string, ExportErrorCode> = {
  permission: "PERMISSION_DENIED",
  engine: "ENGINE_UNAVAILABLE",
  musescore: "MUSESCORE_UNAVAILABLE",
  failed: "EXPORT_FAILED",
};

export interface MockExportPortOptions {
  museScore?: ToolInfo;
  ffmpeg?: ToolInfo;
  /** Simulated latency for capabilities()/export(). */
  latencyMs?: number;
  /** Deterministic failure for export() — recovery-path tests. */
  failure?: ExportErrorCode;
  defaultDestination?: string;
}

export class MockExportPort implements ExportPort {
  private readonly options: Required<
    Pick<MockExportPortOptions, "latencyMs" | "defaultDestination">
  > &
    MockExportPortOptions;

  constructor(options: MockExportPortOptions = {}) {
    this.options = { latencyMs: 450, defaultDestination: "", ...options };
  }

  /** Browser-dev factory: honours the localStorage dev flags above. */
  static withDevOverrides(): MockExportPort {
    let museScore: ToolInfo | undefined;
    let failure: ExportErrorCode | undefined;
    try {
      if (window.localStorage.getItem(DEV_MUSESCORE_KEY) === "missing") {
        museScore = { status: "missing" };
      }
      const f = window.localStorage.getItem(DEV_FAILURE_KEY);
      if (f && f in DEV_FAILURE_CODES) failure = DEV_FAILURE_CODES[f];
    } catch {
      /* localStorage may be unavailable — defaults are fine */
    }
    return new MockExportPort({ museScore, failure });
  }

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.options.latencyMs));
  }

  async capabilities(
    overrides?: ToolPathOverrides,
  ): Promise<ExportCapabilities> {
    await this.delay();
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
      engineInfo: MOCK_ENGINE,
      protocolVersion: 1,
      backend: "basic-pitch (mock)",
      museScore: withPathOverride(museScore, overrides?.museScorePath),
      ffmpeg: withPathOverride(ffmpeg, overrides?.ffmpegPath),
    };
  }

  async chooseDestination(current?: string): Promise<string | null> {
    await this.delay();
    // A browser has no native picker — the mock "chooses" deterministically
    // so the destination row exercises the populated state.
    return current ?? (this.options.defaultDestination || this.fallbackDir());
  }

  async defaultDestination(): Promise<string> {
    return this.options.defaultDestination || this.fallbackDir();
  }

  private fallbackDir(): string {
    return "C:\\Users\\user\\Documents\\HornScribe";
  }

  async export(request: ExportRequest): Promise<ExportResult> {
    await this.delay();
    const failure = this.options.failure;
    if (failure) {
      throw new ExportError(failure, `mock export failure: ${failure}`);
    }
    if (request.formats.length === 0) {
      throw new ExportError("EXPORT_FAILED", "no formats selected");
    }
    const basename = request.basename?.trim() || "score";
    const dir = request.destination;
    const files: ExportedFile[] = EXPORT_FORMAT_IDS.filter((f) =>
      request.formats.includes(f),
    ).map((format) => {
      const artifact = ARTIFACT_NAMES[format];
      const name = `${basename}_${artifact}`;
      return { format, name, path: `${dir}\\${name}` };
    });
    return { destination: dir, files };
  }

  async revealInExplorer(): Promise<boolean> {
    // No OS bridge in a browser — honest false; the dialog announces it.
    return false;
  }
}
