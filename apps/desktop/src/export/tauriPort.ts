/**
 * TauriExportPort — the real export backend inside the Tauri webview
 * (#99). MusicXML and MIDI are produced entirely client-side from the
 * live score document (user edits included via musicXml(view)); PDF
 * renders through a detected MuseScore install. No engine process is
 * required for any format.
 *
 * Rust commands (src-tauri/src/export.rs) own the privileged halves:
 * folder picking, artifact writes (granted-dir allowlist), tool
 * probing, explorer reveal and the MuseScore subprocess.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  withPathOverride,
  type ToolInfo,
  type ToolPathOverrides,
} from "../diagnostics/types";
import type { ScoreDocumentPort } from "../score/document";
import { buildMidiFile } from "./midi";
import {
  ExportError,
  type ExportCapabilities,
  type ExportFormatId,
  type ExportPort,
  type ExportRequest,
  type ExportResult,
  type ExportedFile,
} from "./types";

/** ENG-001 filename policy shared with the mock port. */
const ARTIFACT_NAMES: Record<ExportFormatId, string> = {
  concertMusicxml: "concert.musicxml",
  hornMusicxml: "horn_in_f.musicxml",
  concertPdf: "concert.pdf",
  hornPdf: "horn_in_f.pdf",
  playbackMidi: "playback.mid",
  // The real artifact keeps the source's own extension — this is only
  // the display-name fallback when the copy result has no file name.
  sourceAudio: "source.wav",
};

/** What the port needs from the app at export time. */
export interface ExportSource {
  /** Live score document (XML bodies + meta); null = nothing to export. */
  readonly doc: ScoreDocumentPort | null;
  /** Default file basename — audio file stem or score title. */
  readonly basename: string;
  /** Absolute path of the loaded audio when it lives on disk — enables
   *  the sourceAudio bundle format (#87). Null for browser-held bytes. */
   readonly audioPath: string | null;
  /** Original audio file name (extension kept) for the bundle copy. */
   readonly audioName: string | null;
}

interface DetectedToolWire {
  status: string;
  path?: string;
}
interface DetectedToolsWire {
  museScore: DetectedToolWire;
  ffmpeg: DetectedToolWire;
}

function toToolInfo(wire: DetectedToolWire): ToolInfo {
  return wire.status === "found"
    ? { status: "found", path: wire.path }
    : { status: "missing" };
}

/** UTF-8-safe base64 (btoa chokes on multibyte; chunk to stay under the
 *  String.fromCharCode arg limit). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function textToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/** Filesystem-safe basename: strip separators and illegal chars. */
function sanitizeBasename(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.+$/, "")
    .trim();
  return cleaned || "score";
}

function mapInvokeError(err: unknown): ExportError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("PERMISSION_DENIED")) {
    return new ExportError("PERMISSION_DENIED", msg);
  }
  if (msg.includes("MUSESCORE_UNAVAILABLE")) {
    return new ExportError("MUSESCORE_UNAVAILABLE", msg);
  }
  return new ExportError("EXPORT_FAILED", msg);
}

export class TauriExportPort implements ExportPort {
  /** Last tool-path overrides seen by capabilities() — reused by the
   *  PDF branch of export() so a user-specified MuseScore path wins. */
  private overrides?: ToolPathOverrides;

  constructor(private readonly source: () => ExportSource | null) {}

  async capabilities(
    overrides?: ToolPathOverrides,
  ): Promise<ExportCapabilities> {
    this.overrides = overrides;
    const tools = await invoke<DetectedToolsWire>("detect_tools").catch(
      () => null,
    );
    const museScore = withPathOverride(
      tools ? toToolInfo(tools.museScore) : { status: "missing" },
      overrides?.museScorePath,
    );
    const ffmpeg = withPathOverride(
      tools ? toToolInfo(tools.ffmpeg) : { status: "missing" },
      overrides?.ffmpegPath,
    );
    return {
      // Client-side export needs no engine — report that honestly
      // rather than faking a handshake.
      engineInfo: null,
      protocolVersion: null,
      backend: null,
      museScore,
      ffmpeg,
      audioAvailable: this.source()?.audioPath != null,
    };
  }

  async chooseDestination(current?: string): Promise<string | null> {
    try {
      return await invoke<string | null>("export_pick_dir", {
        current: current ?? null,
      });
    } catch (err) {
      throw mapInvokeError(err);
    }
  }

  async defaultDestination(): Promise<string> {
    try {
      return await invoke<string>("export_default_dir");
    } catch (err) {
      throw mapInvokeError(err);
    }
  }

  async export(request: ExportRequest): Promise<ExportResult> {
    const source = this.source();
    if (!source?.doc) {
      throw new ExportError("EXPORT_FAILED", "no score document to export");
    }
    const basename = sanitizeBasename(
      request.basename?.trim() || source.basename || source.doc.meta.title,
    );
    const dir = request.destination;
    const files: ExportedFile[] = [];

    // #87: bundle the source audio itself — a straight fs copy through
    // export_copy_audio (no base64 round-trip for what can be a large
    // file). Runs first so a missing source fails before partial
    // artifacts are written.
    if (request.formats.includes("sourceAudio") && source.audioPath) {
      try {
        const path = await invoke<string>("export_copy_audio", {
          src: source.audioPath,
          dir,
          basename,
        });
        files.push({
          format: "sourceAudio",
          name: path.split(/[\\/]/).pop() ?? `${basename}.wav`,
          path,
        });
      } catch (err) {
        throw mapInvokeError(err);
      }
    }

    // Text/binary artifacts first (single batched write call).
    const batch: { format: ExportFormatId; name: string; dataBase64: string }[] = [];
    for (const format of request.formats) {
      const name = `${basename}_${ARTIFACT_NAMES[format]}`;
      if (format === "concertMusicxml") {
        batch.push({ format, name, dataBase64: textToBase64(source.doc.musicXml("concert")) });
      } else if (format === "hornMusicxml") {
        batch.push({ format, name, dataBase64: textToBase64(source.doc.musicXml("hornF")) });
      } else if (format === "playbackMidi") {
        batch.push({
          format,
          name,
          dataBase64: toBase64(buildMidiFile(source.doc.musicXml("concert"))),
        });
      }
    }
    if (batch.length > 0) {
      let paths: string[];
      try {
        paths = await invoke<string[]>("export_write_files", {
          dir,
          files: batch.map((f) => ({ name: f.name, dataBase64: f.dataBase64 })),
        });
      } catch (err) {
        throw mapInvokeError(err);
      }
      batch.forEach((f, i) =>
        files.push({ format: f.format, name: f.name, path: paths[i] ?? `${dir}\\${f.name}` }),
      );
    }

    // PDFs render through MuseScore — gated by the probe the dialog
    // already ran (a missing tool surfaces as MUSESCORE_UNAVAILABLE).
    const pdfFormats = request.formats.filter(
      (f) => f === "concertPdf" || f === "hornPdf",
    );
    if (pdfFormats.length > 0) {
      const caps = await this.capabilities(this.overrides);
      const exe = caps.museScore.status === "found" ? caps.museScore.path : null;
      if (!exe) {
        throw new ExportError(
          "MUSESCORE_UNAVAILABLE",
          "MuseScore not found; PDF export is unavailable",
        );
      }
      for (const format of pdfFormats) {
        const name = `${basename}_${ARTIFACT_NAMES[format]}`;
        const xml = source.doc.musicXml(format === "hornPdf" ? "hornF" : "concert");
        try {
          const path = await invoke<string>("render_pdf", {
            musescorePath: exe,
            musicXml: xml,
            outPath: `${dir}\\${name}`,
          });
          files.push({ format, name, path });
        } catch (err) {
          throw mapInvokeError(err);
        }
      }
    }

    return { destination: dir, files };
  }

  async revealInExplorer(path: string): Promise<boolean> {
    try {
      await invoke("reveal_in_explorer", { path });
      return true;
    } catch {
      return false;
    }
  }
}
