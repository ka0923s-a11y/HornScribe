/**
 * Production ImportPorts (UI-020).
 *
 * Environment matrix:
 * - Tauri webview: native open dialog via @tauri-apps/plugin-dialog
 *   (capability `dialog:allow-open` — the only plugin grant; no fs/asset
 *   protocol), file bytes via the self-limited `read_audio_bytes` /
 *   `read_project_file` commands (extension allowlist + size cap in Rust).
 * - Plain-browser dev (`vite dev`): `<input type=file>` picker and
 *   File-object drops — bytes come straight from the File, and the
 *   path-only ports throw (they are unreachable in that mode anyway).
 *
 * Every port degrades instead of throwing where a fallback exists, so the
 * shell keeps rendering in a bare browser session.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ja } from "../strings/ja";
import { updateSourceRef } from "../capture/recordings";
import { AUDIO_EXTENSIONS, baseName } from "./formats";
import {
  AudioDecodeError,
  type AudioProbe,
  type DecodedAudio,
  type ImportPorts,
} from "./ports";
import type { AudioFileRef } from "./types";

/** True inside the Tauri webview (the IPC bridge is injected). */
function isTauri(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

/* ------------------------------ file picker ------------------------------ */

async function pickViaDialog(): Promise<AudioFileRef | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      {
        name: ja.import.dialog.audioFilter,
        extensions: [...AUDIO_EXTENSIONS],
      },
      {
        // .hornscribe.json opens as a project (importRefs routes it).
        name: ja.import.dialog.projectFilter,
        extensions: ["json"],
      },
      // An escape hatch so the "unsupported format" recovery path stays
      // reachable through the dialog, not only through drag&drop.
      { name: ja.import.dialog.allFiles, extensions: ["*"] },
    ],
  });
  if (typeof selected !== "string" || selected === "") return null;
  return { kind: "path", path: selected, name: baseName(selected) };
}

// #18: キュー用の複数選択ピッカー — 音声ファイルのみ(プロジェクト
// はキューの対象外)。キャンセルは空配列。
async function pickViaDialogMulti(): Promise<readonly AudioFileRef[]> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: [
      {
        name: ja.import.dialog.audioFilter,
        extensions: [...AUDIO_EXTENSIONS],
      },
    ],
  });
  const paths = Array.isArray(selected)
    ? selected
    : typeof selected === "string" && selected !== ""
      ? [selected]
      : [];
  return paths.map((p) => ({ kind: "path" as const, path: p, name: baseName(p) }));
}

function pickViaFileInputMulti(): Promise<readonly AudioFileRef[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = AUDIO_EXTENSIONS.map((e) => `.${e}`).join(",");
    let settled = false;
    const done = (refs: readonly AudioFileRef[]) => {
      if (settled) return;
      settled = true;
      resolve(refs);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      done(files.map((f) => ({ kind: "file" as const, file: f, name: f.name })));
    });
    input.addEventListener("cancel", () => done([]));
    const onFocus = () => setTimeout(() => done([]), 400);
    window.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}

// #369: the project-only picker — separate command from 音声を開く so
// resuming saved work is discoverable, not guessed. The all-files
// escape hatch stays so a misnamed project file still opens (the
// engine's project validation gives the honest error either way);
// #356's portable package extension joins this same filter list.
async function pickViaProjectDialog(): Promise<AudioFileRef | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      {
        name: ja.import.dialog.projectFilter,
        extensions: ["json"],
      },
      { name: ja.import.dialog.allFiles, extensions: ["*"] },
    ],
  });
  if (typeof selected !== "string" || selected === "") return null;
  return { kind: "path", path: selected, name: baseName(selected) };
}

/**
 * Browser-dev fallback picker. `cancel` is observable on Chrome-family
 * browsers; the window-focus timer covers engines without the event.
 */
function pickViaFileInput(): Promise<AudioFileRef | null> {
  return pickViaFileInputAccept(
    AUDIO_EXTENSIONS.map((e) => `.${e}`).join(",") + ",.json",
  );
}

function pickProjectViaFileInput(): Promise<AudioFileRef | null> {
  return pickViaFileInputAccept(".json");
}

function pickViaFileInputAccept(
  accept: string,
): Promise<AudioFileRef | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    let settled = false;
    const done = (ref: AudioFileRef | null) => {
      if (settled) return;
      settled = true;
      resolve(ref);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      done(file ? { kind: "file", file, name: file.name } : null);
    });
    input.addEventListener("cancel", () => done(null));
    // Focus returning without a change event ≈ cancel (Safari/older engines).
    const onFocus = () => setTimeout(() => done(null), 400);
    window.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}

/* ------------------------------- raw bytes ------------------------------- */

/** Tauri returns binary IPC payloads as ArrayBuffer/Uint8Array; the JSON
 *  fallback is a number[] — normalize all three into a fresh
 *  `Uint8Array<ArrayBuffer>` (a view over a SharedArrayBuffer is not a
 *  valid BlobPart under the typed-array generics). */
function toUint8(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    // Copy: `data.buffer` is ArrayBufferLike — copying guarantees a plain
    // ArrayBuffer for the Blob constructor.
    return new Uint8Array(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (Array.isArray(data)) return new Uint8Array(data as number[]);
  throw new Error("unexpected binary IPC payload");
}

async function invokeBytes(command: string, path: string): Promise<Blob> {
  const raw = await invoke<unknown>(command, { path });
  return new Blob([toUint8(raw)]);
}

/* ------------------------------- decoding -------------------------------- */

const PEAK_BUCKETS = 600;

let sharedAudioContext: AudioContext | null = null;

/** Merge all channels into |peak| buckets for the waveform strip. */
export function computePeaks(buffer: AudioBuffer, buckets = PEAK_BUCKETS): number[] {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const peaks = new Array<number>(buckets).fill(0);
  if (length === 0 || channels === 0) return peaks;
  const per = Math.max(1, Math.floor(length / buckets));
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < buckets; b++) {
      const start = b * per;
      const end = Math.min(start + per, length);
      let peak = peaks[b];
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      peaks[b] = peak;
    }
  }
  return peaks;
}

async function decodeWithWebAudio(blob: Blob): Promise<DecodedAudio> {
  const Ctor: typeof AudioContext | undefined =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    // Headless/test environments — decoding is unavailable, not "bad file".
    throw new AudioDecodeError("AudioContext unavailable");
  }
  sharedAudioContext ??= new Ctor();
  const raw = await blob.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    buffer = await sharedAudioContext.decodeAudioData(raw);
  } catch (e) {
    throw new AudioDecodeError(
      e instanceof Error ? e.message : "decodeAudioData failed",
    );
  }
  return {
    durationSeconds: buffer.duration,
    sampleRate: buffer.sampleRate,
    peaks: computePeaks(buffer),
  };
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------ composition ------------------------------ */

export function createImportPorts(
  options?: {
    /** #365: engine-backed project open — the host wires it to
     *  `session.inspectProject` so desktop opens take the same
     *  migrate+validate path as project.save. */
    inspectProject?: ImportPorts["inspectProject"];
  },
): ImportPorts {
  return {
    inspectProject: options?.inspectProject,
    pickAudio: () => (isTauri() ? pickViaDialog() : pickViaFileInput()),
    pickAudioMulti: () =>
      isTauri() ? pickViaDialogMulti() : pickViaFileInputMulti(),
    pickProject: () =>
      isTauri() ? pickViaProjectDialog() : pickProjectViaFileInput(),
    readAudioBytes: (path) => invokeBytes("read_audio_bytes", path),
    readProjectBytes: (path) => invokeBytes("read_project_file", path),
    decodeAudio: (blob) => decodeWithWebAudio(blob),
    sha256Hex,
    // #147: keep the persistent source-ref index in step with project
    // opens — the Settings badge/delete warning then sees references
    // beyond the 8-entry MRU.
    updateSourceRef: (projectPath, sourcePath) => {
      void updateSourceRef(projectPath, sourcePath);
    },
    // #230: native ingest — hash/metadata/peaks computed in Rust and
    // playback streamed via the media:// scheme, so path-backed
    // sources never copy their bytes into the webview. null → the
    // controller falls back to the byte path (browser dev, probe
    // failure).
    probeAudio: async (path) => {
      if (!isTauri()) return null;
      try {
        return await invoke<AudioProbe>("audio_probe", { path });
      } catch {
        return null;
      }
    },
  };
}
