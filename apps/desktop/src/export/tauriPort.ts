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
  type ExportErrorCode,
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
  bFlatMusicxml: "b_flat.musicxml",
  concertPdf: "concert.pdf",
  hornPdf: "horn_in_f.pdf",
  bFlatPdf: "b_flat.pdf",
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
  // #384: Rust errors arrive as `CODE` or `CODE: detail` — the token
  // before the first colon is the stable UI-facing code; anything
  // after stays in the message for diagnostics and never reaches the
  // dialog. Unknown/untagged failures collapse to EXPORT_FAILED.
  const head = msg.trimStart().split(":", 1)[0]?.trim() ?? "";
  const code = INVOKE_ERROR_CODES.find((c) => c === head);
  return new ExportError(code ?? "EXPORT_FAILED", msg);
}

/** Codes the Rust export commands may emit — prefix-matched by
 *  mapInvokeError (#384). */
const INVOKE_ERROR_CODES: readonly ExportErrorCode[] = [
  "PERMISSION_DENIED",
  "ENGINE_UNAVAILABLE",
  "MUSESCORE_UNAVAILABLE",
  "EXPORT_DISK_FULL",
  "EXPORT_SOURCE_MISSING",
  "EXPORT_MUSESCORE_RENDER_FAILED",
  "EXPORT_DESTINATION_INVALID",
  "EXPORT_WRITE_FAILED",
  "EXPORT_COMMIT_FAILED",
  "EXPORT_NAME_INVALID",
  "EXPORT_NAME_EXHAUSTED",
  "EXPORT_INTERNAL",
  "EXPORT_CANCELLED",
  "EXPORT_FAILED",
];

export class TauriExportPort implements ExportPort {
  /** Last tool-path overrides seen by capabilities() — reused by the
   *  PDF branch of export() so a user-specified MuseScore path wins. */
  private overrides?: ToolPathOverrides;

  /** #256: canonical MIDI via the engine's playback_midi_bytes — keeps
   *  velocity / pitch bend / swing / tempo map. When absent (or the
   *  document has no canonical payload) the client-side MusicXML→MIDI
   *  rebuild is used as before. #390: a FAILED engine call degrades
   *  to that same client-side build instead of aborting the whole
   *  transaction — MusicXML/PDF never needed the worker. */
  private readonly midiExporter?: (scoreDocument: unknown) => Promise<string>;

  /** #390: engine-liveness probe — false means the canonical MIDI
   *  RPC would just burn a round trip on a dead worker, so export()
   *  goes straight to the client-side build and reports degraded. */
  private readonly engineReady?: () => boolean;

  /** Monotonic id source for `export_run`/`export_cancel` pairing —
   *  collision-safe per export attempt (#383). */
  private exportSeq = 0;

  constructor(
    private readonly source: () => ExportSource | null,
    midiExporter?: (scoreDocument: unknown) => Promise<string>,
    engineReady?: () => boolean,
  ) {
    this.midiExporter = midiExporter;
    this.engineReady = engineReady;
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
    const doc = this.source()?.doc;
    const canonical = doc?.canonicalDocument?.();
    return {
      // Client-side export needs no engine handshake — report that
      // honestly rather than faking one. #390: the ONE engine-dependent
      // artifact is the canonical playback MIDI; its tier is reported
      // separately via playbackMidi below.
      engineInfo: null,
      protocolVersion: null,
      backend: null,
      museScore,
      ffmpeg,
      playbackMidi: !doc
        ? "unavailable"
        : canonical && this.midiExporter && this.engineReady?.() !== false
          ? "canonical"
          : "degraded",
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

  async export(
    request: ExportRequest,
    signal?: AbortSignal,
  ): Promise<ExportResult> {
    // #383: a cancelled run throws EXPORT_CANCELLED — the dialog treats
    // it as a quiet abort, never an error surface.
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new ExportError("EXPORT_CANCELLED", "export cancelled");
      }
    };
    throwIfAborted();
    const source = this.source();
    if (!source?.doc) {
      // #384: a missing document is a client-side precondition bug —
      // the dialog offers retry/diagnostics, not destination advice.
      throw new ExportError("EXPORT_INTERNAL", "no score document to export");
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
      (f) => f === "concertPdf" || f === "hornPdf" || f === "bFlatPdf",
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
          throw new ExportError("EXPORT_NAME_EXHAUSTED", "no free export name");
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
    // #390: formats that landed at reduced quality — disclosed to
    // the user via the result, never silently downgraded.
    const degraded: ExportFormatId[] = [];
    for (const format of request.formats) {
      const name = names.get(format);
      if (!name) continue;
      if (format === "concertMusicxml") {
        batch.push({ name, dataBase64: textToBase64(source.doc.musicXml("concert")) });
      } else if (format === "hornMusicxml") {
        batch.push({ name, dataBase64: textToBase64(source.doc.musicXml("hornF")) });
      } else if (format === "bFlatMusicxml") {
        batch.push({ name, dataBase64: textToBase64(source.doc.musicXml("bFlat")) });
      } else if (format === "playbackMidi") {
        // #256/#390: prefer the engine's canonical exporter (velocity /
        // bend / swing / tempo map survive). A dead or failing engine
        // no longer aborts the transaction — this ONE format degrades
        // to the client-side MusicXML→MIDI rebuild; the result flags
        // the downgrade. engineReady()===false skips the doomed RPC.
        const canonical = source.doc.canonicalDocument?.();
        let producedCanonical = false;
        if (
          canonical &&
          this.midiExporter &&
          this.engineReady?.() !== false
        ) {
          try {
            batch.push({
              name,
              dataBase64: await this.midiExporter(canonical),
            });
            producedCanonical = true;
          } catch {
            producedCanonical = false;
          }
        }
        if (!producedCanonical) {
          batch.push({
            name,
            dataBase64: toBase64(
              buildMidiFile(source.doc.musicXml("concert")),
            ),
          });
          // Only a real canonical path lost counts as degraded — a
          // document without a canonical payload never had a better
          // producer to begin with.
          if (canonical && this.midiExporter) degraded.push("playbackMidi");
        }
      } else if (
        format === "concertPdf" ||
        format === "hornPdf" ||
        format === "bFlatPdf"
      ) {
        pdfPayloads.push({
          name,
          musicXml: source.doc.musicXml(
            format === "hornPdf"
              ? "hornF"
              : format === "bFlatPdf"
                ? "bFlat"
                : "concert",
          ),
        });
      }
    }

    // #258: one transactional call — audio + files + PDFs are staged
    // and committed together; a failure anywhere writes nothing.
    // #383: the run is cancellable end-to-end — exportId pairs with
    // export_cancel, which flips the Rust-side flag and kills the
    // MuseScore child; staging then tears down without committing.
    const exportId = `hornscribe-export-${Date.now()}-${++this.exportSeq}`;
    const onAbort = () => {
      void invoke("export_cancel", { exportId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let paths: string[];
    try {
      throwIfAborted();
      paths = await invoke<string[]>("export_run", {
        dir,
        audio: wantsAudio
          ? { name: names.get("sourceAudio"), src: source.audioPath }
          : null,
        files: batch,
        pdfs: pdfPayloads,
        musescorePath: museScorePath,
        exportId,
      }).catch((err) => {
        throw mapInvokeError(err);
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

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
    return {
      destination: dir,
      files,
      degraded: degraded.length > 0 ? degraded : undefined,
    };
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
   *  argument picks concert / F管 / B♭管 written pitch — the same
   *  document the user is looking at, edits included. */
  async openInMuseScore(
    view: "concert" | "hornF" | "bFlat",
    overrides?: ToolPathOverrides,
  ): Promise<string> {
    const source = this.source();
    if (!source?.doc) {
      throw new ExportError("EXPORT_INTERNAL", "no score document to open");
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
