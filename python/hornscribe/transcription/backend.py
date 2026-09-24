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
from collections.abc import Callable
from typing import Any

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    IdAllocator,
    TranscriptionRevisionId,
    derive_transcription_revision_id,
)

BACKEND_ID = "basic_pitch"
BACKEND_VERSION = "0.4.0"

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
    for onset_s, offset_s, pitch_midi, amplitude, _bends in note_events:
        events.append(
            RawNoteEvent(
                id=allocator.allocate_raw_event_id(),
                transcription_revision=revision,
                pitch_midi=float(pitch_midi),
                onset_sec=float(onset_s),
                offset_sec=float(offset_s),
                confidence=float(amplitude),
                velocity=max(1, min(127, int(round(float(amplitude) * 110)))),
                source=BACKEND_ID,
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
