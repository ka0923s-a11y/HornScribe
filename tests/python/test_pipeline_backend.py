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


def test_vocal_isolation_resolves_pyin(tmp_path, monkeypatch) -> None:
    """#316: a successfully isolated vocal is monophonic — the auto
    backend resolves to pYIN (the singing tracker), not Basic Pitch."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs"),
    )
    called: list[str] = []

    def fake_pyin(path, revision, **kw):
        called.append("pyin")
        return _events()

    def fake_bp(path, revision, **kw):
        called.append("bp")
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events_pyin", fake_pyin)
    monkeypatch.setattr(pipeline, "predict_note_events", fake_bp)
    result = _run(
        tmp_path, {"backend": "auto", "vocalIsolation": True}
    )
    assert called == ["pyin"]
    assert result["meta"]["backend"] == PYIN_BACKEND_ID
    # pYIN on an isolated vocal is the right engine — the
    # monophonic-backend warning stays off.
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "monophonic_backend" not in reasons


def test_vocal_isolation_failure_keeps_basic_pitch(
    tmp_path, monkeypatch
) -> None:
    """#316: isolation that produced nothing leaves the polyphonic
    model in place — the raw mix is not a monophonic vocal."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: (None, "unavailable", False, None),
    )
    called: list[str] = []

    monkeypatch.setattr(
        pipeline,
        "predict_note_events_pyin",
        lambda *a, **k: called.append("pyin") or _events(),
    )
    monkeypatch.setattr(
        pipeline,
        "predict_note_events",
        lambda *a, **k: called.append("bp") or _events(),
    )
    _run(tmp_path, {"backend": "auto", "vocalIsolation": True})
    assert called == ["bp"]


def test_vocal_isolation_voices_keeps_polyphonic(
    tmp_path, monkeypatch
) -> None:
    """#316: voices/chords asked for every detected line — the
    # polyphonic model stays even on an isolated vocal."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs"),
    )
    called: list[str] = []
    monkeypatch.setattr(
        pipeline,
        "predict_note_events_pyin",
        lambda *a, **k: called.append("pyin") or _events(),
    )
    monkeypatch.setattr(
        pipeline,
        "predict_note_events",
        lambda *a, **k: called.append("bp") or _events(),
    )
    _run(
        tmp_path,
        {"backend": "auto", "texture": "voices", "vocalIsolation": True},
    )
    assert called == ["bp"]


def test_vocal_isolation_stages_isolated_wav(tmp_path, monkeypatch) -> None:
    """#187: vocalIsolation=on runs the backend on the isolated WAV,
    marks the result, and echoes the option in settings."""
    captured: dict = {}

    def fake(path, *args, **kw):
        captured["path"] = path
        return _events()

    # Fake the isolation stage: the pipeline must consume whatever
    # vocal_wav returns — a managed cache path here.
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs"),
    )
    result = _run(tmp_path, {"vocalIsolation": True}, fake_backend=fake)
    assert captured["path"] == "/tmp/hs-vocal.wav"
    assert result["meta"]["settings"]["vocalIsolation"] is True
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "vocal_isolation_applied" in reasons


def test_vocal_isolation_unavailable_reports_reason(
    tmp_path, monkeypatch
) -> None:
    """#187: a failed/mono isolation falls back to the raw path and
    the review issue says why — never silent."""
    captured: dict = {}

    def fake(path, *args, **kw):
        captured["path"] = path
        return _events()

    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: (None, "mono_source", False, None),
    )
    result = _run(tmp_path, {"vocalIsolation": True}, fake_backend=fake)
    # Fallback: the backend saw the original audio path.
    assert captured["path"].endswith("take.wav")
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "vocal_isolation_unavailable" in reasons
    result = _run(tmp_path, {"vocalIsolation": True}, fake_backend=fake)
    # Fallback: the backend saw the original audio path.
    assert captured["path"].endswith("take.wav")
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "vocal_isolation_unavailable" in reasons
