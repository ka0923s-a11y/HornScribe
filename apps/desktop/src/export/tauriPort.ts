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
  type ToolPathOverrides,
} from "../diagnostics/types";
import {
  detectTools,
  resolveToolWithOverride,
} from "../diagnostics/toolProbe";
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

/** Mirror of the Rust-side audio stem sanitize (export_copy_audio):
 *  path/illegal chars AND dots become underscores so the predicted
 *  `<stem>_source.<ext>` name matches what export_run writes. */
function sanitizeAudioStem(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|.]/g, "_")
    .trim();
  return cleaned || "audio";
}

/** Audio file extension (lowercased) for the bundle copy name. */
function audioExtOf(name: string | null): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name ?? "");
  return m ? m[1].toLowerCase() : "wav";
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

  /** #256: canonical MIDI via the engine's playback_midi_bytes — keeps
   *  velocity / pitch bend / swing / tempo map. When absent (or the
   *  document has no canonical payload) the client-side MusicXML→MIDI
   *  rebuild is used as before. */
  private readonly midiExporter?: (scoreDocument: unknown) => Promise<string>;

  constructor(
    private readonly source: () => ExportSource | null,
    midiExporter?: (scoreDocument: unknown) => Promise<string>,
  ) {
    this.midiExporter = midiExporter;
  }

  async capabilities(
    overrides?: ToolPathOverrides,
  ): Promise<ExportCapabilities> {
    this.overrides = overrides;
    const tools = await detectTools();
    // #363: a user-set override is probed against the filesystem — a
    // bad path reports missing (with the path kept) instead of a blind
    // 検出済み that only fails at export time.
    const [museScore, ffmpeg] = await Promise.all([
      resolveToolWithOverride(
        tools?.museScore ?? { status: "missing" },
        overrides?.museScorePath,
      ),
      resolveToolWithOverride(
        tools?.ffmpeg ?? { status: "missing" },
        overrides?.ffmpegPath,
      ),
    ]);
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
    // Plan every artifact up front: names are needed for the
    // collision check (#231) before anything is staged (#258).
    const wantsAudio =
      request.formats.includes("sourceAudio") && source.audioPath != null;
    const pdfFormats = request.formats.filter(
      (f) => f === "concertPdf" || f === "hornPdf",
    );
    const plan = (stem: string) => {
      const names = new Map<ExportFormatId, string>();
      for (const format of request.formats) {
        if (format === "sourceAudio") {
          if (wantsAudio) {
            names.set(
              format,
              `${sanitizeAudioStem(stem)}_source.${audioExtOf(source.audioName)}`,
            );
          }
        } else {
          names.set(format, `${stem}_${ARTIFACT_NAMES[format]}`);
        }
      }
      return names;
    };

    // #231: never overwrite silently — ask once for the whole set.
    let stem = basename;
    let names = plan(stem);
    let existing = await invoke<string[]>("export_check_existing", {
      dir,
      names: [...names.values()],
    }).catch((err) => {
      throw mapInvokeError(err);
    });
    if (existing.length > 0 && request.onCollision) {
      const policy = await request.onCollision(existing);
      if (policy === "cancel") {
        throw new ExportError("EXPORT_CANCELLED", "export cancelled");
      }
      if (policy === "rename") {
        // Re-stem the whole set — every artifact of one export shares
        // one basename, so a suffix keeps the bundle coherent.
        for (let n = 2; n <= 999 && existing.length > 0; n++) {
          stem = `${basename}_${n}`;
          names = plan(stem);
          existing = await invoke<string[]>("export_check_existing", {
            dir,
            names: [...names.values()],
          }).catch((err) => {
            throw mapInvokeError(err);
          });
        }
        if (existing.length > 0) {
          // Pathological: 999 stems taken — refuse rather than
          // silently overwriting after the user chose rename.
          throw new ExportError("EXPORT_FAILED", "no free export name");
        }
      }
    }

    // Resolve MuseScore before staging anything — a missing tool must
    // fail before the transaction, not inside it (#258).
    let museScorePath: string | null = null;
    if (pdfFormats.length > 0) {
      const caps = await this.capabilities(this.overrides);
      museScorePath =
        caps.museScore.status === "found" ? (caps.museScore.path ?? null) : null;
      if (!museScorePath) {
        throw new ExportError(
          "MUSESCORE_UNAVAILABLE",
          "MuseScore not found; PDF export is unavailable",
        );
      }
    }

    // Build payloads: text/binary artifacts go base64; PDFs carry
    // their MusicXML source for the staged render; audio is a path
    // copy (no base64 round-trip for what can be a large file).
    const batch: { name: string; dataBase64: string }[] = [];
    const pdfPayloads: { name: string; musicXml: string }[] = [];
    for (const format of request.formats) {
      const name = names.get(format);
      if (!name) continue;
      if (format === "concertMusicxml") {
        batch.push({ name, dataBase64: textToBase64(source.doc.musicXml("concert")) });
      } else if (format === "hornMusicxml") {
        batch.push({ name, dataBase64: textToBase64(source.doc.musicXml("hornF")) });
      } else if (format === "playbackMidi") {
        // #256: prefer the engine's canonical exporter — it carries
        // velocity / pitch bend / swing / tempo map the MusicXML
        // rebuild loses. Falls back to the client-side build only
        // when no canonical payload or no engine hook exists.
        const canonical = source.doc.canonicalDocument?.();
        if (canonical && this.midiExporter) {
          let midiBase64: string;
          try {
            midiBase64 = await this.midiExporter(canonical);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new ExportError("EXPORT_FAILED", msg);
          }
          batch.push({ name, dataBase64: midiBase64 });
        } else {
          batch.push({
            name,
            dataBase64: toBase64(buildMidiFile(source.doc.musicXml("concert"))),
          });
        }
      } else if (format === "concertPdf" || format === "hornPdf") {
        pdfPayloads.push({
          name,
          musicXml: source.doc.musicXml(format === "hornPdf" ? "hornF" : "concert"),
        });
      }
    }

    // #258: one transactional call — audio + files + PDFs are staged
    // and committed together; a failure anywhere writes nothing.
    const paths = await invoke<string[]>("export_run", {
      dir,
      audio: wantsAudio
        ? { name: names.get("sourceAudio"), src: source.audioPath }
        : null,
      files: batch,
      pdfs: pdfPayloads,
      musescorePath: museScorePath,
    }).catch((err) => {
      throw mapInvokeError(err);
    });

    // export_run returns staged-commit order: audio, files, then PDFs —
    // map back onto formats by name for the result list.
    const byName = new Map(paths.map((p) => [p.split(/[\\/]/).pop() ?? "", p]));
    for (const format of request.formats) {
      const name = names.get(format);
      if (!name) continue;
      files.push({
        format,
        name,
        path: byName.get(name) ?? `${dir}\\${name}`,
      });
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

  /** §13 高度編集: hand the live score to the MuseScore GUI. The view
   *  argument picks concert vs F管 written pitch — the same document the
   *  user is looking at, edits included. */
  async openInMuseScore(
    view: "concert" | "hornF",
    overrides?: ToolPathOverrides,
  ): Promise<string> {
    const source = this.source();
    if (!source?.doc) {
      throw new ExportError("EXPORT_FAILED", "no score document to open");
    }
    const caps = await this.capabilities(overrides ?? this.overrides);
    const exe = caps.museScore.status === "found" ? caps.museScore.path : null;
    if (!exe) {
      throw new ExportError(
        "MUSESCORE_UNAVAILABLE",
        "MuseScore not found; set its path in 設定 → ツール",
      );
    }
    try {
      return await invoke<string>("open_in_musescore", {
        musescorePath: exe,
        musicXml: source.doc.musicXml(view),
        basename: source.basename || source.doc.meta.title,
      });
    } catch (err) {
      throw mapInvokeError(err);
    }
  }
}
