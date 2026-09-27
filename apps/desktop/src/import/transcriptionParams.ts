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
import { DEFAULT_TRANSCRIPTION_OPTIONS } from "./types";
import { KEY_HINT_VALUES } from "./types";

function audioPathOf(ref: AudioFileRef | RecordedAudioRef): string | null {
  if (ref.kind === "path") return ref.path;
  if (ref.kind === "recording") return ref.path ?? null;
  return null; // kind === "file": browser dev, no on-disk source
}

export interface TranscriptionJobParams {
  audioPath?: string;
  /** #305: the user's file name for the score title — audioPath may
   *  be a staged temp path, so the display name travels separately. */
  displayName?: string;
  tempoBpm?: number;
  meter?: string;
  minDuration?: string;
  triplets?: string;
  simplicity?: string;
  range?: string;
  selectionStartSec?: number;
  selectionEndSec?: number;
  backend?: string;
  texture?: string;
  /** #355: voice cap for voices/chords (engine param, 2..8). */
  maxVoices?: number;
  /** #187: opt-in vocal isolation (center extraction) for the job. */
  vocalIsolation?: boolean;
  /** #53: user-pinned key signature ("auto" omitted). */
  keyHint?: string;
}

export function buildTranscriptionParams(
  audio: LoadedAudio | null,
  options: TranscriptionOptions,
  stagedAudioPath: string | null = null,
  backend: string | null = null,
): TranscriptionJobParams {
  const params: TranscriptionJobParams = {};
  const path = stagedAudioPath ?? (audio ? audioPathOf(audio.ref) : null);
  if (path) params.audioPath = path;
  // #305: the score title comes from the user's file name — a staged
  // temp path must never surface as staged-<ts>-<name> on the page.
  if (audio?.fileName) params.displayName = audio.fileName;

  // #108/#189: the engine pin reaches the job. A per-job override
  // (options.backend) wins over the global 設定→詳細設定 choice.
  const resolvedBackend =
    options.backend && options.backend !== "auto"
      ? options.backend
      : backend;
  if (resolvedBackend && resolvedBackend !== "auto") {
    params.backend = resolvedBackend;
  }

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
  // "auto" is the engine default; pin mono/melody explicitly so the
  // choice is recorded in the job settings echo.
  if (options.texture !== "auto") params.texture = options.texture;
  // #355: the voice cap only means something to the polyphonic
  // textures — emit it there and only when it differs from the
  // engine default so the settings echo stays honest.
  if (
    (options.texture === "voices" || options.texture === "chords") &&
    options.maxVoices !== DEFAULT_TRANSCRIPTION_OPTIONS.maxVoices
  ) {
    params.maxVoices = options.maxVoices;
  }
  // #187: opt-in vocal isolation — false is the engine default; only
  // an explicit on reaches the job so provenance stays honest.
  if (options.vocalIsolation) params.vocalIsolation = true;
  // #53: "auto" is the engine default — pin only an explicit key.
  if (options.keyHint && options.keyHint !== "auto") {
    params.keyHint = options.keyHint;
  }
  if (options.range === "selection") {
    params.range = "selection";
    // #346: clamp into [0, duration] but NEVER widen an empty/inverted
    // pair to the full span — that silently changes the job's meaning.
    // The UI blocks submission on such input (invalidSelectionRange);
    // if it ever slips through, the engine's explicit selection error
    // is the honest outcome.
    const dur = audio?.durationSeconds ?? 0;
    let start = options.selectionStartSec ?? 0;
    let end = options.selectionEndSec ?? dur;
    start = Math.min(Math.max(start, 0), dur);
    end = Math.min(Math.max(end, 0), dur);
    params.selectionStartSec = start;
    params.selectionEndSec = end;
  }
  return params;
}

/** #346: is the user's 選択範囲 input invalid — clamped into
 *  [0, duration] and still empty or inverted? The audioReady form
 *  marks the field and disables 採譜を開始 while this holds, instead
 *  of silently transcribing the whole song (#88/#229 range contract).
 *  Unset fields default to the full span (valid). */
export function invalidSelectionRange(
  options: Pick<TranscriptionOptions, "range"> &
    Partial<
      Pick<TranscriptionOptions, "selectionStartSec" | "selectionEndSec">
    >,
  durationSeconds: number,
): boolean {
  if (options.range !== "selection") return false;
  const dur = Math.max(durationSeconds, 0);
  const start = Math.min(Math.max(options.selectionStartSec ?? 0, 0), dur);
  const end = Math.min(Math.max(options.selectionEndSec ?? dur, 0), dur);
  return end <= start;
}

/** #61: is the 手動 tempo choice missing its BPM — tempo="manual" with
 *  no tempoBpm? Params would omit the value and the engine silently
 *  falls back to auto beat-tracking, ignoring the explicit choice.
 *  Same contract as invalidSelectionRange: flag the field, gate the
 *  primary action. */
export function invalidManualTempo(
  options: Pick<TranscriptionOptions, "tempo"> &
    Partial<Pick<TranscriptionOptions, "tempoBpm">>,
): boolean {
  return options.tempo === "manual" && options.tempoBpm == null;
}

/** Every form-level option error, in one call — both the AUDIO_READY
 *  popover and the score-screen options dialog gate their primary
 *  action on this (#346 selection range, #61 manual tempo). */
export function invalidTranscriptionOptions(
  options: TranscriptionOptions,
  durationSeconds: number,
): boolean {
  return (
    invalidSelectionRange(options, durationSeconds) ||
    invalidManualTempo(options)
  );
}

/* ------------------------- #264 project settings ------------------------- */

/** Engine `settings_dict()` keys -> 採譜オプション state. The saved
 *  echo is authoritative provenance: on project open the popover is
 *  restored to the conditions that produced the score, so 採譜し直す
 *  reproduces them instead of silently using current global defaults.
 *  Unknown/newer values fall back to DEFAULT per key. */
export function transcriptionOptionsFromSettings(
  settings: Record<string, unknown> | null | undefined,
): TranscriptionOptions {
  const s = settings ?? {};
  const pick = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const v = s[key];
    return typeof v === "string" && (allowed as readonly string[]).includes(v)
      ? (v as T)
      : fallback;
  };
  const num = (key: string): number | null => {
    const v = s[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const tempoBpm = num("tempoBpm");
  // UI denominators are note values (16th = 1/4 ql); the engine echo
  // stores quarter-length fractions ("1/4"). Only the three UI
  // choices are restorable — anything else falls back to default.
  const minDuration = (() => {
    const raw = s["minDurationQl"];
    if (typeof raw !== "string") return DEFAULT_TRANSCRIPTION_OPTIONS.minDuration;
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw.trim());
    if (!m) return DEFAULT_TRANSCRIPTION_OPTIONS.minDuration;
    const ql = Number(m[1]) / Number(m[2]);
    if (!(ql > 0)) return DEFAULT_TRANSCRIPTION_OPTIONS.minDuration;
    const denom = Math.round(4 / ql);
    return denom === 8 || denom === 16 || denom === 32
      ? String(denom)
      : DEFAULT_TRANSCRIPTION_OPTIONS.minDuration;
  })();

  const tripletsRaw = pick("triplets", ["auto", "always", "never"] as const, "auto");
  return {
    ...DEFAULT_TRANSCRIPTION_OPTIONS,
    tempo: tempoBpm != null ? "manual" : "auto",
    tempoBpm,
    meter: pick(
      "meter",
      ["auto", "2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "9/8", "12/8"] as const,
      "auto",
    ),
    minDuration,
    // Engine values are the TripletPolicy names; the popover speaks
    // allow/none/auto (always <-> allow, never <-> none).
    triplets:
      tripletsRaw === "always" ? "allow" : tripletsRaw === "never" ? "none" : "auto",
    simplicity: pick("simplicity", ["standard", "simple", "detailed"] as const, "standard"),
    range: pick("range", ["all", "selection"] as const, "all"),
    texture: pick("texture", ["auto", "mono", "melody", "voices", "chords"] as const, "auto"),
    // Engine bounds are 2..8 — an out-of-range echo falls back to the
    // default rather than pinning an impossible cap on re-transcribe.
    maxVoices: (() => {
      const v = num("maxVoices");
      return v != null && Number.isInteger(v) && v >= 2 && v <= 8
        ? v
        : DEFAULT_TRANSCRIPTION_OPTIONS.maxVoices;
    })(),
    backend: pick("backend", ["auto", "basicPitch", "pyin"] as const, "auto"),
    vocalIsolation: s.vocalIsolation === true,
    // #53: restore a pinned key verbatim — an unknown name falls back
    // to auto rather than pinning a key the engine would reject.
    keyHint: pick("keyHint", KEY_HINT_VALUES, "auto"),
    // Selection seconds are source-relative; keep them verbatim so a
    // restored 範囲指定 re-runs over the same span of the same audio.
    selectionStartSec: num("selectionStartSec"),
    selectionEndSec: num("selectionEndSec"),
  };
}
