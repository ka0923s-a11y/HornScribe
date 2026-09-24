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
 * - `kind:"file"` (browser dev drop) and pathless recordings -> no
 *   audioPath; the mock port ignores params anyway, so dev sessions
 *   still exercise the flow. A future staging step can copy browser
 *   bytes to a temp file (tracked as a follow-up issue).
 *
 * `tempoBpm` is only sent for manual tempo — auto omits it so the
 * engine runs beat tracking. `range:"selection"` is unreachable from
 * the current UI (the waveform selection control is not wired), but
 * the mapping is honest for when it lands.
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
): TranscriptionJobParams {
  const params: TranscriptionJobParams = {};
  const path = audio ? audioPathOf(audio.ref) : null;
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
    // The UI has no selection surface yet; the engine requires bounds
    // for selection mode, so send the full duration as the honest
    // current selection.
    params.selectionStartSec = 0;
    params.selectionEndSec = audio?.durationSeconds ?? 0;
  }
  return params;
}
