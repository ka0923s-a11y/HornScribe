"""Basic Pitch backend adapter (lazy, optional dependency).

``basic_pitch`` (and its ONNX runtime) is an *engine* extra
(``pip install hornscribe[engine]``). Everything here is imported lazily
so the worker can run — and the frontend keep working against the mock
port — on a Python that lacks the model stack. A missing dependency
raises :class:`EngineDependencyError`, which the worker maps to the
``ENGINE_DEPENDENCY_MISSING`` job error (never a crash).

Backend tuning for a monophonic horn line (accuracy pass, ENG-002):

* ``onset_threshold=0.4`` / ``frame_threshold=0.3`` — slightly more
  sensitive than the 0.5/0.3 defaults; horn onsets are soft and the
  downstream monophonic clean-up absorbs the extra hypotheses.
* ``minimum_note_length=70 ms`` — below the 127.7 ms default; real
  sixteenth-note runs at allegro are ~80-120 ms. Sub-70 ms detections
  are almost always octave flicker.
* ``minimum_frequency=55 Hz`` / ``maximum_frequency=880 Hz`` — the
  sounding horn range (F1..A5) widened by ~a semitone each way so
  out-of-range detections still surface as review issues instead of
  being silently dropped by the model.
* Melody-texture jobs widen the cap to ``MELODY_MAX_FREQUENCY_HZ`` —
  JPOP vocals and mix melodies sit well above the horn range, and the
  downstream range review still flags out-of-horn notes honestly.
* ``melodia_trick=True`` (default) keeps the salience-based cleanup.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import logging
import math
from collections.abc import Callable
from typing import Any

from hornscribe.domain.events import PitchBendPoint, RawNoteEvent
from hornscribe.domain.ids import (
    IdAllocator,
    RawNoteEventId,
    TranscriptionRevisionId,
    derive_transcription_revision_id,
)

BACKEND_ID = "basic_pitch"
BACKEND_VERSION = "0.4.0"
# #175: librosa.pyin monophonic tracker — same RawNoteEvent surface,
# different engine provenance.
PYIN_BACKEND_ID = "pyin"

log = logging.getLogger(__name__)

# Horn in F sounding range F1..A5 (43.65..880 Hz), widened ~a semitone so
# borderline detections reach the range-review stage instead of being cut.
MIN_FREQUENCY_HZ = 55.0
MAX_FREQUENCY_HZ = 880.0
# Melody/mix sources: JPOP vocals reach ~E6 and harmonized melody lines
# sit above the horn range — the horn-fit projection happens downstream.
MELODY_MAX_FREQUENCY_HZ = 1400.0
ONSET_THRESHOLD = 0.4
FRAME_THRESHOLD = 0.3
MINIMUM_NOTE_LENGTH_MS = 70.0

# Basic Pitch reports per-frame pitch bends in MIDI pitch-bend units
# (0..16383, center 8192) over a +/-2 semitone range -> 4096 units per
# semitone. We keep them as evidence (vibrato / portamento) instead of
# dropping them (#169).
_BEND_CENTER = 8192.0
_BEND_UNITS_PER_SEMITONE = 4096.0


def _bend_points(
    bends: Any, onset_sec: float, offset_sec: float
) -> tuple[PitchBendPoint, ...]:
    """Convert a backend bend list to PitchBendPoint evidence (#169).

    bends is a per-frame list of MIDI pitch-bend values spanning the
    note's [onset, offset]; frame i maps to the evenly spaced time inside
    that span. Non-numeric or empty input yields no points.
    """
    if not bends:
        return ()
    try:
        values = [float(b) for b in bends]
    except (TypeError, ValueError):
        return ()
    if not values:
        return ()
    span = offset_sec - onset_sec
    denom = max(1, len(values) - 1)
    out: list[PitchBendPoint] = []
    for i, v in enumerate(values):
        t = onset_sec + span * (i / denom)
        semis = (v - _BEND_CENTER) / _BEND_UNITS_PER_SEMITONE
        out.append(PitchBendPoint(time_sec=t, bend_semitones=semis))
    return tuple(out)


def frames_to_note_events(
    f0_hz: Any,
    times_sec: Any,
    voiced_flag: Any,
    voiced_prob: Any,
    *,
    min_note_sec: float = 0.07,
) -> list[tuple[float, float, float, float, list[int]]]:
    """librosa.pyin frame output -> Basic-Pitch-style note tuples (#175).

    pyin is a monophonic tracker: each frame is either unvoiced (f0 NaN /
    voiced_flag False) or carries a continuous f0 in Hz. We group voiced
    frames into runs whose rounded MIDI pitch stays constant (a vibrato
    oscillation stays on one note instead of splitting), merge runs
    separated by a single unvoiced frame, and drop runs shorter than
    min_note_sec. Each surviving run becomes
    (onset, offset, pitch_midi, amplitude, bends) — the same tuple shape
    predict_note_events consumes — where pitch_midi is the run's
    quantized median pitch and bends are the per-frame MIDI pitch-bend
    units of the continuous f0 measured from that note pitch, so
    note + bend reproduces the tracked contour (vibrato, scoops).
    """
    f0 = [float(x) for x in f0_hz]
    times = [float(x) for x in times_sec]
    voiced = [bool(x) for x in voiced_flag]
    prob = [float(x) for x in voiced_prob]
    n = len(f0)
    if n == 0:
        return []
    frame_dt = (times[1] - times[0]) if n > 1 else 0.01

    def to_midi(hz: float) -> float:
        return 69.0 + 12.0 * math.log2(hz / 440.0)

    # Runs of consecutive voiced frames sharing one rounded pitch.
    runs: list[list[int]] = []
    cur: list[int] = []
    cur_pc: int | None = None
    for i in range(n):
        if not voiced[i] or math.isnan(f0[i]) or f0[i] <= 0:
            if cur:
                runs.append(cur)
                cur = []
                cur_pc = None
            continue
        pc = int(round(to_midi(f0[i])))
        if cur and pc == cur_pc:
            cur.append(i)
        else:
            if cur:
                runs.append(cur)
            cur = [i]
            cur_pc = pc
    if cur:
        runs.append(cur)

    # Merge runs split by a single unvoiced frame (tracker dropout).
    merged: list[list[int]] = []
    for run in runs:
        if (
            merged
            and run[0] - merged[-1][-1] == 2
            and int(round(to_midi(f0[run[0]])))
            == int(round(to_midi(f0[merged[-1][-1]])))
        ):
            merged[-1].extend(range(merged[-1][-1] + 1, run[0]))
            merged[-1].extend(run)
        else:
            merged.append(list(run))

    out: list[tuple[float, float, float, float, list[int]]] = []
    for run in merged:
        onset = times[run[0]]
        offset = times[run[-1]] + frame_dt
        if offset - onset < min_note_sec:
            continue
        # Interior unvoiced frames (merged single-frame dropouts) have no
        # usable f0 — pyin emits NaN there — so borrow the nearest voiced
        # neighbour for the bend series instead of feeding NaN to log2.
        midis = [to_midi(f0[i]) if f0[i] > 0 else float("nan") for i in run]
        for k in range(len(run)):
            if not math.isnan(midis[k]):
                continue
            prev = midis[k - 1] if k > 0 else None
            nxt = (
                to_midi(f0[run[k + 1]])
                if k + 1 < len(run) and f0[run[k + 1]] > 0
                else None
            )
            if prev is not None and nxt is not None:
                midis[k] = (prev + nxt) / 2.0
            elif prev is not None:
                midis[k] = prev
            elif nxt is not None:
                midis[k] = nxt
            else:
                midis[k] = 0.0
        midis_sorted = sorted(midis)
        center = midis_sorted[len(midis_sorted) // 2]
        # Bend baseline is the quantized note pitch (same convention as
        # Basic Pitch), not the raw median — otherwise a run centred
        # between semitones would lose its +0.5 st offset on playback.
        note_pitch = float(int(round(center)))
        # Voiced probability can be NaN on dropout frames; average over
        # the finite values so confidence stays a real number.
        probs = [prob[i] for i in run if not math.isnan(prob[i])]
        amp = sum(probs) / len(probs) if probs else 0.0
        bends = [
            max(
                0,
                min(
                    16383,
                    int(
                        round(
                            8192 + (m - note_pitch) * _BEND_UNITS_PER_SEMITONE
                        )
                    ),
                ),
            )
            for m in midis
        ]
        out.append((onset, offset, note_pitch, amp, bends))
    return out


def _to_raw_event(
    note_event: Any,
    event_id: RawNoteEventId,
    revision: TranscriptionRevisionId,
    source: str = BACKEND_ID,
) -> RawNoteEvent:
    """Map one backend note tuple to RawNoteEvent, keeping bends (#169)."""
    onset_s, offset_s, pitch_midi, amplitude = note_event[:4]
    bends = note_event[4] if len(note_event) > 4 else ()
    onset_f = float(onset_s)
    offset_f = float(offset_s)
    return RawNoteEvent(
        id=event_id,
        transcription_revision=revision,
        pitch_midi=float(pitch_midi),
        onset_sec=onset_f,
        offset_sec=offset_f,
        confidence=float(amplitude),
        velocity=max(1, min(127, int(round(float(amplitude) * 110)))),
        source=source,
        pitch_bends=_bend_points(bends, onset_f, offset_f),
    )


class EngineDependencyError(RuntimeError):
    """A required engine package is not importable in this Python.

    Carries the pip extra name so the UI can point at the dependency
    surface; the worker maps it to ``ENGINE_DEPENDENCY_MISSING``.
    """

    def __init__(self, package: str, detail: str = "") -> None:
        self.package = package
        super().__init__(
            f"engine dependency {package!r} is not installed"
            + (f" ({detail})" if detail else "")
        )


def require_module(name: str) -> None:
    """Raise :class:`EngineDependencyError` unless ``name`` imports."""
    if importlib.util.find_spec(name) is None:
        raise EngineDependencyError(name)


def load_mono_audio(audio_path: str) -> tuple[Any, int]:
    """Decode *audio_path* to mono float32 at 22050 Hz (librosa).

    Returns ``(samples, sample_rate)``. Any decode failure raises
    ``ValueError`` with a stable message — the worker maps it to
    ``JOB_FAILED`` with the audio-preparation detail.
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency

    try:
        samples, sr = librosa.load(audio_path, sr=22050, mono=True)
    except Exception as exc:
        raise ValueError(f"could not decode audio {audio_path!r}: {exc}") from exc
    if samples.size == 0:
        raise ValueError(f"audio file decoded to zero samples: {audio_path!r}")
    return samples, int(sr)


def predict_note_events(
    audio_path: str,
    *,
    revision: TranscriptionRevisionId,
    max_frequency_hz: float = MAX_FREQUENCY_HZ,
) -> tuple[RawNoteEvent, ...]:
    """Run Basic Pitch on *audio_path* -> raw note events (engine stage).

    ``predict`` is a single blocking ONNX call — cooperative cancellation
    cannot interrupt it (ENGINE_RUNTIME_MATRIX.md); the worker's
    terminate/restart fallback covers aborting mid-inference.

    ``max_frequency_hz`` widens the detection band for melody-texture
    jobs whose line lives above the horn range.
    """
    require_module("basic_pitch")
    from basic_pitch.inference import predict  # noqa: PLC0415

    # basic_pitch prints "Predicting MIDI for ..." to stdout — that would
    # corrupt the worker's NDJSON channel, so capture it to the log.
    chatter = io.StringIO()
    try:
        with contextlib.redirect_stdout(chatter):
            _output, _midi, note_events = predict(
                audio_path,
                onset_threshold=ONSET_THRESHOLD,
                frame_threshold=FRAME_THRESHOLD,
                minimum_note_length=MINIMUM_NOTE_LENGTH_MS,
                minimum_frequency=MIN_FREQUENCY_HZ,
                maximum_frequency=max_frequency_hz,
                melodia_trick=True,
            )
    except EngineDependencyError:
        raise
    except Exception as exc:
        raise ValueError(f"basic_pitch inference failed: {exc}") from exc
    for line in chatter.getvalue().splitlines():
        if line.strip():
            log.info("basic_pitch: %s", line.strip())

    allocator = IdAllocator("rne")
    events: list[RawNoteEvent] = []
    for note_event in note_events:
        events.append(
            _to_raw_event(
                note_event,
                allocator.allocate_raw_event_id(),
                revision,
            )
        )
    return tuple(events)


def predict_note_events_pyin(
    audio_path: str,
    *,
    revision: TranscriptionRevisionId,
    min_frequency_hz: float = MIN_FREQUENCY_HZ,
    max_frequency_hz: float = MAX_FREQUENCY_HZ,
) -> tuple[RawNoteEvent, ...]:
    """Run librosa.pyin on *audio_path* -> raw note events (#175).

    pyin is a monophonic probabilistic-YIN tracker: better suited to a
    single sung/played line (JPOP vocals, horn) than the polyphonic
    Basic Pitch model — it tracks continuous f0 per frame, so vibrato
    stays inside one note and octave flicker is rare. The frame output
    is converted by frames_to_note_events into the same tuple shape
    Basic Pitch emits, keeping the downstream pipeline identical.

    pyin is a single blocking call — cooperative cancellation cannot
    interrupt it (same caveat as predict_note_events); the worker's
    terminate/restart fallback covers aborting mid-inference.
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415

    try:
        samples, sr = librosa.load(audio_path, sr=22050, mono=True)
        f0, voiced_flag, voiced_prob = librosa.pyin(
            samples,
            fmin=min_frequency_hz,
            fmax=max_frequency_hz,
            sr=sr,
        )
    except Exception as exc:
        raise ValueError(f"pyin inference failed: {exc}") from exc
    times = librosa.times_like(f0, sr=sr)
    note_events = frames_to_note_events(
        f0, times, voiced_flag, voiced_prob,
        min_note_sec=MINIMUM_NOTE_LENGTH_MS / 1000.0,
    )

    allocator = IdAllocator("rne")
    events: list[RawNoteEvent] = []
    for note_event in note_events:
        events.append(
            _to_raw_event(
                note_event,
                allocator.allocate_raw_event_id(),
                revision,
                source=PYIN_BACKEND_ID,
            )
        )
    return tuple(events)


def new_transcription_revision(
    audio_path: str, settings: dict[str, Any]
) -> TranscriptionRevisionId:
    """Content-derived ``tr-*`` id for one backend run (ids.py contract)."""
    return derive_transcription_revision_id(
        {"backend": BACKEND_ID, "version": BACKEND_VERSION,
         "audioPath": audio_path, "settings": settings}
    )


def backend_available() -> bool:
    """True when the model stack is importable (handshake capability)."""
    return importlib.util.find_spec("basic_pitch") is not None


# Type alias kept private: tests inject fakes with this shape.
NoteBackend = Callable[[str], tuple[RawNoteEvent, ...]]
