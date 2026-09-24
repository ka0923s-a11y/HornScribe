# ENG-002 — real transcription pipeline (audio -> score)

Status: implemented (worker + Tauri spawn + shell wiring).
Scope: the `transcription` job kind is a real pipeline end to end —
audio file -> Basic Pitch note events -> monophonic clean-up -> beat
map -> HSQ quantization -> canonical ScoreDocument -> MusicXML
(concert + written F管) delivered through `job.event` `completed`
`result`. The shell renders it via `XmlScoreDocument` (no fixture
substitution in production).

## Stage map (matches TRANSCRIPTION_STAGE_IDS / GUI_UX_SPEC §5)

| stage              | module                | work                                             |
|--------------------|-----------------------|--------------------------------------------------|
| preparing_audio    | backend.py            | librosa decode -> mono 22050 Hz + SHA-256 hash    |
| transcribing       | backend.py            | basic_pitch `predict` (one blocking ONNX call)    |
| cleaning           | clean.py              | monophonic repair: merge/clip/drop + range clip   |
| analyzing_rhythm   | tempo.py              | beat_track -> BeatMap/TimeWarp or manual grid     |
| quantizing         | rhythm/quantizer      | HSQ-v1 DP quantization (k-best alternatives)      |
| building_score     | scorebuild.py + key.py| canonical payload, Krumhansl key estimate, issues |
| rendering          | export/musicxml       | concert + horn-in-F MusicXML bodies               |

Cancellation/deadline are cooperative *between* stages — Basic Pitch
inference is a single blocking call (ENGINE_RUNTIME_MATRIX), so
mid-inference abort uses the documented terminate/restart fallback.

## Free-stack rationale (完全無料運用)

Every component is free and local: basic-pitch (Apache-2.0, bundled
ONNX model), librosa, music21, Verovio. No cloud calls, no paid APIs,
no telemetry. `pip install hornscribe[engine]` carries the model deps.

## Accuracy choices (精度面)

- Backend: onset 0.4 / frame 0.3 thresholds, min note 70 ms, 55-880 Hz
  window (horn F1..A5 + margin), melodia trick on.
- Monophonic repair before quantization (the product contract is a
  single horn line): same-pitch merges <30 ms, <40 ms drops, overlap
  clipping to the next onset.
- Beat tracking gives a piecewise-linear TimeWarp (follows rit./accel.);
  a pinned manual tempo uses a fixed grid anchored on the first onset.
- Pickup/anacrusis: beat-map anchors lift by whole beats when the first
  onset precedes beat 0; the lift becomes the meter's measure phase.
- Key: duration-weighted Krumhansl-Schmuckler over quantized pitches.
- Review issues are evidence-bearing, never silent corrections:
  quantizer reasons + low_model_confidence (<0.5) +
  outside_preferred_horn_range + very_short_detection (<90 ms).

## Failure contract

- `ENGINE_DEPENDENCY_MISSING` — basic_pitch/librosa not importable
  (details.package names it). Handshake advertises
  `basicPitchAvailable` so the UI can warn early.
- `NO_PITCHED_CONTENT` — clean run, zero notes (silence/noise).
- `JOB_FAILED` — undecodable audio, backend error, unsupported meter.
- `JOB_TIMEOUT` — `deadlineMs` exceeded between stages.

## Transport

`src-tauri/src/engine.rs` spawns `python -m hornscribe.worker`:
interpreter via `HORNSCRIBE_PYTHON` -> repo venvs -> PATH; module path
via `HORNSCRIBE_PYTHONPATH` -> repo `python/`. Frames stream over a
Tauri `Channel` (`{kind:"line"|"stderr"|"exit"}`); stdin EOF = graceful
shutdown; `engine_kill` + exit hook prevent sidecar leaks.

## Known limits (tracked as issues)

- Packaged app still needs a reachable Python+engine env — bundling a
  frozen runtime is a follow-up.
- `meter:"auto"` resolves to 4/4 (reported honestly via
  `meta.meterEstimated`); real meter estimation is a follow-up.
- Monophonic sources only; polyphonic input yields a single line.
- Browser-dev `kind:"file"` sources have no `audioPath` — the mock
  port covers dev; staging bytes to a temp file is a follow-up.
- basic_pitch `predict` cannot be cancelled mid-call (documented).
