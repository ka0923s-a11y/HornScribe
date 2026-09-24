/**
 * Import ports — the typed seams between the import controller and its
 * environment (UI-020; mirrors the port/adapter style used by the UI-004
 * TransportController contract).
 *
 * `ImportController` depends only on this interface, so tests drive fake
 * ports and the production wiring (`runtimePorts.ts`) selects Tauri IPC or
 * browser fallbacks per capability — never by sniffing in the controller.
 */
import type { AudioFileRef } from "./types";

/** Result of decoding audio for display (waveform + metadata). */
export interface DecodedAudio {
  durationSeconds: number;
  sampleRate: number;
  /** Normalized peak amplitudes 0–1. */
  peaks: readonly number[];
}

/** Thrown by `decodeAudio` when the bytes cannot be decoded — the
 *  controller maps it to the recoverable `openFailed` issue. */
export class AudioDecodeError extends Error {
  constructor(message = "decodeAudioData failed") {
    super(message);
    this.name = "AudioDecodeError";
  }
}

export interface ImportPorts {
  /**
   * Show the file picker (Tauri dialog plugin; `<input type=file>` in
   * browser dev). Resolves null when the user cancels — cancel is not an
   * error and never surfaces copy.
   */
  pickAudio(): Promise<AudioFileRef | null>;
  /** Bytes of a `kind:"path"` ref (Rust `read_audio_bytes` command). */
  readAudioBytes(path: string): Promise<Blob>;
  /** Bytes of a `.hornscribe.json` project file (`read_project_file`). */
  readProjectBytes(path: string): Promise<Blob>;
  /** Decode audio for the waveform/metadata (WebAudio decodeAudioData). */
  decodeAudio(blob: Blob, fileName: string): Promise<DecodedAudio>;
  /**
   * SHA-256 of file contents as lowercase hex — the same contract as
   * `hash_file_sha256` in python/hornscribe/project/model.py, so relink
   * verification matches `ProjectStore.relink_source_audio`.
   */
  sha256Hex(blob: Blob): Promise<string>;

  /** Optional (#147): record the opened/saved project's sourceAudio ref
   *  into the persistent source-ref index (appDataDir/source-refs.json)
   *  so references survive MRU truncation. Fire-and-forget — failures
   *  must not fail the open. */
  updateSourceRef?(projectPath: string, sourcePath: string | null): void;
}
