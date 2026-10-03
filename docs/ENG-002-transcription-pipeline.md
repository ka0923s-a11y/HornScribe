# ENG-002 — real transcription pipeline (audio -> score)

Status: implemented (worker + Tauri spawn + shell wiring).
Scope: the `transcription` job kind is a real pipeline end to end —
audio file -> backend note events (Basic Pitch or pYIN) -> clean-up -> beat
map -> HSQ quantization -> canonical ScoreDocument -> MusicXML
(concert + written F管) delivered through `job.event` `completed`
`result`. The shell renders it via `XmlScoreDocument` (no fixture
substitution in production).

## Backend selection (#175, #189)

Two engines share one event tuple shape, so everything downstream is
identical:

- **Basic Pitch** (basic_pitch ONNX, bundled nmp.onnx) — polyphonic
  model; the default and the right pick for mixes.
- **pYIN** (librosa.pyin + HPSS + onset-guided splitting, #180) —
  monophonic f0 tracker; better on a single sung/played line (vibrato
  stays inside one note, octave flicker is rare). No model download —
  still fully free/offline.

backend:auto resolves per job: texture:mono picks pYIN, everything
else picks Basic Pitch. A per-job backend option (import screen) and
the global setting can pin either engine. pYIN under a polyphonic
texture (voices/auto) emits a monophonic_backend review issue with a
one-click Basic Pitch re-run (#181/#183).

## Stage map (matches TRANSCRIPTION_STAGE_IDS / GUI_UX_SPEC §5)

| stage              | module                | work                                             |
|--------------------|-----------------------|--------------------------------------------------|
| preparing_audio    | backend.py            | librosa decode -> mono 22050 Hz + SHA-256 hash    |
| transcribing       | backend.py            | basic_pitch predict or librosa.pyin               |
| cleaning           | clean.py              | monophonic repair: merge/clip/drop + range clip   |
| analyzing_rhythm   | tempo.py              | beat_track -> BeatMap/TimeWarp or manual grid     |
| quantizing         | rhythm/quantizer      | HSQ-v1 DP quantization (k-best alternatives)      |
| building_score     | scorebuild.py + key.py| canonical payload, Krumhansl key estimate, issues |
| rendering          | export/musicxml       | concert + horn-in-F MusicXML bodies               |

Cancellation/deadline are cooperative *between* stages — Basic Pitch
inference is a single blocking call (ENGINE_RUNTIME_MATRIX), so
mid-inference abort uses the documented terminate/restart fallback.
pYIN is likewise one blocking call with the same caveat.

## Free-stack rationale (完全無料運用)

Every component is free and local: basic-pitch (Apache-2.0, bundled
ONNX model), librosa, music21, Verovio. No cloud calls, no paid APIs,
no telemetry. `pip install hornscribe[engine]` carries the model deps.

## Accuracy choices (精度面)

- Backend: onset 0.4 / frame 0.3 thresholds, min note 70 ms, 55-880 Hz
  window (horn F1..A5 + margin), melodia trick on.
- Monophonic repair before quantization (the product contract is a
  single horn line): same-pitch merges <30 ms, <40 ms drops, overlap
  clipping to the next onset. Isolated notes exactly an octave off
  BOTH neighbours' shared pitch class snap to the neighbour octave
  (Basic Pitch octave flicker; real leaps are untouched — the count
  is reported via `meta.cleaning.octaveCorrected`).
- Melody-texture (prefer="top") arbitration hardening — every rule is
  evidence-bearing and measured on the e2e bench (all 25 fixtures at
  pitch accuracy 1.0 / onset F1 1.0 as of v0.2.5):
  - a lower hypothesis that attacked WITH the top may claim the slot
    only when it outlives it by >50 ms (frame-edge overhang is noise)
    or re-attacks inside/just past the overlay's claimed end —
    accompaniment that merely rings louder does not displace the line;
  - an incumbent that modulates like a sung line INSIDE the contested
    window is veto-protected against steady-tone challengers (the span
    is windowed because a merged overlay's union bend series fakes
    vibrato by pooling fragment offsets);
  - a sub-32nd event ending flush at a successor exactly one octave
    away is Basic Pitch's attack-transient octave flicker — it folds
    into the successor (keeping the stub's earlier onset as the true
    attack) instead of scoring a phantom 32nd.
- Beat tracking gives a piecewise-linear TimeWarp (follows rit./accel.);
  a pinned manual tempo uses a fixed grid anchored on the first onset.
- Auto meter (`meter:"auto"` + auto tempo): onset strength sampled at
  each tracked beat scores 2/4, 3/4, 4/4 by measure-start accent
  ratio; 6/8 requires a lag-6 accent with a secondary lag-3 accent on
  an eighth-note pulse (tracked anchors then bind eighths, not dotted
  quarters). Weak evidence falls back to 4/4 and emits a
  `meter_conflict` review issue; the pick and margin are reported via
  `meta.meter` / `meta.meterConfidence`.
- Beat-tracker edge cases: a missed first beat (onset ~1 interval
  before beat 0) is synthesized onto the grid, and a beat 0 landing a
  fraction of a pulse after the first onset snaps to the onset —
  otherwise real downbeats misread as pickups.
- Pickup/anacrusis: beat-map anchors lift by whole beats when the first
  onset precedes beat 0; the lift becomes the meter's measure phase.
- Key: duration-weighted Krumhansl-Schmuckler over quantized pitches,
  with cadence bias (final note x2, first x1.5) so diatonic melodies
  resolve the real tonic instead of tying to the relative minor.
- Review issues are evidence-bearing, never silent corrections:
  quantizer reasons + low_model_confidence (<0.5) +
  outside_preferred_horn_range + very_short_detection (<90 ms) +
  overlapping_candidates (dense mixes, with a voices re-run hint on
  auto/mono textures — #148/#200) + monophonic_backend (pYIN under a
  polyphonic texture — #181) + meter_conflict + swing_feel (#134) +
  tempo_uncertain (half/double tempo pick — #188; the fix is
  scaleTempo, not setTempo — #198).

## Texture modes (#85, #148, #155)

- mono — single line; overlaps clip to the next onset.
- melody — melody over accompaniment; overlap resolution prefers
  the top voice and widens the detection band above the horn cap.
- voices — up to three detected lines become separate parts;
  extras beyond three are reported as dropped.
- chords — same three-line split as voices, then merged into ONE
  part: notes sharing (start, duration, atoms) render as in-part
  <chord/> members; other overlaps become secondary voices
  (<backup>/<voice>) inside the same staff. Canonical rests tile
  the primary layer; secondary layers gap-fill with hidden
  (print-object=no) rests.
- auto — starts as mono; a dense overlap census re-cleans with the
  top-voice preference and flags suggestVoicesTexture on the
  overlap issue (#200 extends the same hint to explicit mono).

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
- Auto meter is accent-based and conservative: weak or ambiguous
  accent structure falls back to 4/4 with a `meter_conflict` issue
  rather than guessing; 6/8 requires the tracker to hold the
  eighth-note pulse.
- Polyphonic input is best-effort: voices keeps up to three lines,
  melody/mono collapse to one — the overlap issue reports what
  was merged or dropped.
- Browser-dev `kind:"file"` sources have no `audioPath` — the mock
  port covers dev; staging bytes to a temp file is a follow-up.
- basic_pitch `predict` cannot be cancelled mid-call (documented).
