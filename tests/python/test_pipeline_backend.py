"""#236/#237: detection band + resolved-backend revision identity.

texture=auto must run the widened detection band so high melodies
survive to the auto classifier (#236), and the transcription revision
must be derived from the RESOLVED backend identity — pyin jobs carry a
pyin/librosa-derived tr-* id, not a Basic Pitch one (#237).
"""

from __future__ import annotations

import threading
from array import array

import pytest

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    TranscriptionRevisionId,
)
from hornscribe.transcription import pipeline
from hornscribe.transcription.backend import (
    MELODY_MAX_FREQUENCY_HZ,
    PYIN_BACKEND_ID,
)
from hornscribe.transcription.options import TranscriptionParams
from hornscribe.transcription.pipeline import run_transcription_job


def _events() -> tuple[RawNoteEvent, ...]:
    rev = TranscriptionRevisionId("tr-000001")

    def ev(i: int, pitch: int, onset: float, offset: float) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-{i:06d}"),
            transcription_revision=rev,
            pitch_midi=float(pitch),
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.9,
            velocity=80,
            source="test",
        )

    return (
        ev(1, 72, 0.0, 0.5),
        ev(2, 74, 0.5, 1.0),
        ev(3, 76, 1.0, 1.5),
        ev(4, 77, 1.5, 2.0),
    )


def _run(tmp_path, payload_extra, monkeypatch=None, fake_backend=None):
    audio = tmp_path / "take.wav"
    audio.write_bytes(b"x" * 64)
    collected: list[dict] = []

    def emit(phase: str, **kw) -> None:
        collected.append({"phase": phase, **kw})

    params = TranscriptionParams.from_payload(
        {
            "audioPath": str(audio),
            "tempoBpm": 120.0,
            "meter": "4/4",
            **payload_extra,
        }
    )
    run_transcription_job(
        job_id="j",
        params=params,
        emit=emit,
        cancel=threading.Event(),
        backend=fake_backend,
        loader=lambda _p: (array("f", [0.0] * (22050 * 5)), 22050),
    )
    assert collected[-1]["phase"] == "completed", collected
    return collected[-1]["result"]


@pytest.mark.parametrize(
    "texture,expect_wide",
    [
        ("auto", True),
        ("melody", True),
        ("voices", True),
        ("chords", True),
        ("mono", False),
    ],
)
def test_detection_band_follows_texture(
    tmp_path, monkeypatch, texture, expect_wide
) -> None:
    """#236: auto/melody/polyphonic textures run the 1400 Hz band; the
    explicitly-monophonic texture keeps the narrow horn band."""
    seen: list[dict] = []

    def fake(path, revision, **kw):
        seen.append(kw)
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events", fake)
    _run(
        tmp_path,
        {"texture": texture, "backend": "basicPitch"},
    )
    assert len(seen) == 1
    if expect_wide:
        assert seen[0]["max_frequency_hz"] == MELODY_MAX_FREQUENCY_HZ
    else:
        assert "max_frequency_hz" not in seen[0]


def test_pyin_revision_uses_resolved_identity(tmp_path, monkeypatch) -> None:
    """#237: a pYIN job's tr-* id is derived from the pyin backend
    identity, and the raw events inherit that same revision."""
    captured: dict = {}

    def fake_pyin(path, revision, **kw):
        captured["revision"] = str(revision)
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events_pyin", fake_pyin)
    result = _run(tmp_path, {"backend": "pyin"})
    meta = result["meta"]
    assert meta["backend"] == PYIN_BACKEND_ID
    assert meta["transcriptionRevision"] == captured["revision"]

    # The same audio + settings under Basic Pitch must mint a
    # DIFFERENT revision — backend identity is part of the id.
    def fake_bp(path, revision, **kw):
        captured["bp_revision"] = str(revision)
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events", fake_bp)
    result_bp = _run(tmp_path, {"backend": "basicPitch"})
    assert result_bp["meta"]["backend"] == "basic_pitch"
    assert captured["bp_revision"] != captured["revision"]


def test_auto_mono_resolves_pyin_identity(tmp_path, monkeypatch) -> None:
    """#237: backend=auto + texture=mono resolves to pYIN, and the
    revision reflects that resolution — not the default backend."""
    captured: dict = {}

    def fake_pyin(path, revision, **kw):
        captured["revision"] = str(revision)
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events_pyin", fake_pyin)
    result = _run(tmp_path, {"backend": "auto", "texture": "mono"})
    assert result["meta"]["backend"] == PYIN_BACKEND_ID
    assert result["meta"]["transcriptionRevision"] == captured["revision"]
