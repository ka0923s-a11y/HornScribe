/**
 * Build the `job.start` params for the real `transcription` job kind
 * (ENG-002) from the loaded audio + the 採譜オプション popover state.
 *
 * Wire contract (python/hornscribe/transcription/options.py):
 * `audioPath` is required — the engine reads the file itself, so only
 * refs backed by a real path can drive a real job:
 *
 * - `kind:"path"` (native dialog / native drop) -> the path itself;
 * - `kind:"recording"` with `path` (Tauri capture: the WAV was already
 *   persisted under appDataDir/recordings/) -> that path;
 * - `kind:"file"` (browser dev drop) and pathless recordings -> staged
 *   first via stageAudioForEngine (#86): the dev bridge writes the bytes
 *   under %TEMP%/hornscribe-dev and the returned path is passed in as
 *   `stagedAudioPath`, which wins over every ref-derived path. When the
 *   bridge is unreachable staging returns null and the mock engine
 *   ignores params anyway, so dev sessions still exercise the flow.
 *
 * `tempoBpm` is only sent for manual tempo — auto omits it so the
 * engine runs beat tracking. `range:"selection"` sends the user's
 * start/end seconds, clamped to the clip duration.
 */
import type {
  AudioFileRef,
  LoadedAudio,
  RecordedAudioRef,
  TranscriptionOptions,
} from "./types";

function audioPathOf(ref: AudioFileRef | RecordedAudioRef): string | null {
  if (ref.kind === "path") return ref.path;
  if (ref.kind === "recording") return ref.path ?? null;
  return null; // kind === "file": browser dev, no on-disk source
}

export interface TranscriptionJobParams {
  audioPath?: string;
  tempoBpm?: number;
  meter?: string;
  minDuration?: string;
  triplets?: string;
  simplicity?: string;
  range?: string;
  selectionStartSec?: number;
  selectionEndSec?: number;
}

export function buildTranscriptionParams(
  audio: LoadedAudio | null,
  options: TranscriptionOptions,
  stagedAudioPath: string | null = null,
): TranscriptionJobParams {
  const params: TranscriptionJobParams = {};
  const path = stagedAudioPath ?? (audio ? audioPathOf(audio.ref) : null);
  if (path) params.audioPath = path;

  if (options.tempo === "manual" && options.tempoBpm != null) {
    params.tempoBpm = options.tempoBpm;
  }
  // "auto" meter is the engine default; only pin an explicit choice.
  if (options.meter && options.meter !== "auto") {
    params.meter = options.meter;
  }
  if (options.minDuration) params.minDuration = options.minDuration;
  if (options.triplets !== "auto") params.triplets = options.triplets;
  if (options.simplicity !== "standard") {
    params.simplicity = options.simplicity;
  }
  if (options.range === "selection") {
    params.range = "selection";
    // The engine requires end > start for selection mode; clamp the
    // user's seconds into [0, duration] and fall back to the full span
    // when the pair is empty or inverted.
    const dur = audio?.durationSeconds ?? 0;
    let start = options.selectionStartSec ?? 0;
    let end = options.selectionEndSec ?? dur;
    start = Math.min(Math.max(start, 0), dur);
    end = Math.min(Math.max(end, 0), dur);
    if (end <= start) {
      start = 0;
      end = dur;
    }
    params.selectionStartSec = start;
    params.selectionEndSec = end;
  }
  return params;
}
