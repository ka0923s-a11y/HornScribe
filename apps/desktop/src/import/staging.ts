/**
 * stageAudioForEngine (#86) — hand browser-held audio bytes to the dev
 * engine bridge so `kind:"file"` drops and pathless recordings can drive
 * a real transcription job.
 *
 * Refs that already live on disk (`kind:"path"`, recordings persisted by
 * the Tauri capture) need no staging — buildTranscriptionParams picks
 * their path up directly. Only in-browser bytes are POSTed to
 * `/__engine/stage`, which writes them under %TEMP%/hornscribe-dev and
 * returns a real path for `job.start`.
 *
 * Returns null when there is nothing to stage or the bridge is not
 * reachable (mock engine dev sessions keep working — the mock ignores
 * params anyway).
 */

import type { AudioFileRef, LoadedAudio, RecordedAudioRef } from "./types";

function bytesOf(ref: AudioFileRef | RecordedAudioRef): Blob | null {
  if (ref.kind === "file") return ref.file;
  if (ref.kind === "recording" && !ref.path && ref.blob) return ref.blob;
  return null; // kind === "path", or a recording already on disk
}

export async function stageAudioForEngine(
  audio: LoadedAudio | null,
): Promise<string | null> {
  if (!audio) return null;
  const bytes = bytesOf(audio.ref);
  if (!bytes) return null;
  try {
    const res = await fetch(
      "/__engine/stage?name=" + encodeURIComponent(audio.fileName),
      { method: "POST", body: bytes },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { path?: unknown };
    return typeof body.path === "string" ? body.path : null;
  } catch {
    return null;
  }
}
