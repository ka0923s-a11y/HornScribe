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
    """#316/#165: on an isolated vocal BOTH engines run — pYIN wins
    the gate when its track agrees with the Basic Pitch melody line
    (here the fake engines return the same line -> agreement 1.0)."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs", "4.0.1"),
    )
    called: list[str] = []

    captured: dict = {}

    def fake_pyin(path, revision, **kw):
        called.append("pyin")
        captured["revision"] = str(revision)
        return _events()

    def fake_bp(path, revision, **kw):
        called.append("bp")
        return _events()

    monkeypatch.setattr(pipeline, "predict_note_events_pyin", fake_pyin)
    monkeypatch.setattr(pipeline, "predict_note_events_rescued", fake_bp)
    result = _run(
        tmp_path, {"backend": "auto", "vocalIsolation": True}
    )
    # The gate consults both engines — Basic Pitch arbitrates the
    # melody line first, then pYIN's track is measured against it.
    assert called == ["bp", "pyin"]
    assert result["meta"]["backend"] == PYIN_BACKEND_ID
    # The adopted track's own revision becomes THE tr-* id (#237).
    assert result["meta"]["transcriptionRevision"] == captured["revision"]
    gate = result["meta"]["preprocess"]["leadTrackGate"]
    assert gate["adopted"] == "pyin"
    assert gate["pyinAgreement"] == 1.0
    # pYIN on an isolated vocal is the right engine — the
    # monophonic-backend warning stays off.
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "monophonic_backend" not in reasons


def test_vocal_isolation_gate_rejects_disagreeing_pyin(
    tmp_path, monkeypatch
) -> None:
    """#165: a bleed-heavy estimate leaves the bass louder than the
    lead — pYIN locks that line end-to-end while Basic Pitch finds
    the melody.  Agreement ~0 means the polyphonic model's line wins
    and the tracker is thrown away."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "center_extraction", "1"),
    )
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

    # BP (rescued pass): the melody line at lead register.
    monkeypatch.setattr(
        pipeline,
        "predict_note_events_rescued",
        lambda path, revision, **kw: _events(),
    )
    # pYIN: tracked a bass line two+ octaves below — disagreement.
    monkeypatch.setattr(
        pipeline,
        "predict_note_events_pyin",
        lambda path, revision, **kw: (
            ev(11, 36, 0.0, 1.0),
            ev(12, 41, 1.0, 2.0),
        ),
    )
    result = _run(
        tmp_path, {"backend": "auto", "vocalIsolation": True}
    )
    meta = result["meta"]
    assert meta["backend"] == "basic_pitch"
    assert meta["backendVersion"].endswith("+rescue")
    gate = meta["preprocess"]["leadTrackGate"]
    assert gate["adopted"] == "basicPitch"
    assert gate["pyinAgreement"] < pipeline.LEAD_GATE_MIN_AGREEMENT


def test_vocal_isolation_failure_keeps_basic_pitch(
    tmp_path, monkeypatch
) -> None:
    """#316: isolation that produced nothing leaves the polyphonic
    model in place — the raw mix is not a monophonic vocal."""
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: (None, "unavailable", False, None, None),
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
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs", "4.0.1"),
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
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs", "4.0.1"),
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
        lambda *a, **k: (None, "mono_source", False, None, None),
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


def _run_with_source_level(
    tmp_path,
    payload_extra,
    *,
    source_level: float,
    estimate_rms: float | None,
    method: str,
    backend=None,
    loader=None,
):
    """Run the job with a non-silent source and a stubbed isolation
    estimate whose RMS is controllable — the #191 low-lead issue keys
    off estimate/source RMS."""
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
        backend=backend or (lambda _p: _events()),
        loader=loader
        or (
            lambda _p: (
                array("f", [source_level] * (22050 * 5)),
                22050,
            )
        ),
    )
    assert collected[-1]["phase"] == "completed", collected
    return collected[-1]["result"]


def _comb_events(pitch: int = 72, count: int = 9) -> tuple[RawNoteEvent, ...]:
    """A plausible melody long enough for the #214 comb gate — nine
    evenly spaced notes at one pitch."""
    rev = TranscriptionRevisionId("tr-000002")
    return tuple(
        RawNoteEvent(
            id=RawNoteEventId(f"rne-c{i:05d}"),
            transcription_revision=rev,
            pitch_midi=float(pitch),
            onset_sec=i * 0.4,
            offset_sec=i * 0.4 + 0.35,
            confidence=0.9,
            velocity=80,
            source="test",
        )
        for i in range(count)
    )


def _sine_loader(freq_hz: float, amp: float = 0.5):
    """Loader returning a held pure tone at *freq_hz* — the comb gate's
    controlled spectrum."""
    import math

    sr = 22050
    return lambda _p: (
        array(
            "f",
            (
                amp * math.sin(2.0 * math.pi * freq_hz * i / sr)
                for i in range(sr * 4)
            ),
        ),
        sr,
    )


def _stub_isolation(monkeypatch, estimate_rms, method):
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, method, "1.0"),
    )
    monkeypatch.setattr(pipeline, "wav_rms", lambda _p: estimate_rms)


def test_low_lead_level_fires_on_buried_vocal(tmp_path, monkeypatch) -> None:
    """#191: estimate RMS far under the source's => the review issue
    tells the user notes may be missing."""
    _stub_isolation(monkeypatch, estimate_rms=0.04, method="demucs")
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.04,
        method="demucs",
    )
    issues = {i["reason"]: i for i in result["reviewIssues"]}
    assert "low_lead_level" in issues
    assert issues["low_lead_level"]["severity"] == "caution"
    # ratio 0.04/0.5 = 0.08 -> about -21.9 dB.
    assert issues["low_lead_level"]["evidence"]["ratioDb"] == pytest.approx(
        -21.9, abs=0.2
    )


def test_low_lead_level_silent_on_healthy_estimate(
    tmp_path, monkeypatch
) -> None:
    """#191: a normal-strength estimate produces no false alarm."""
    _stub_isolation(monkeypatch, estimate_rms=0.30, method="demucs")
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.30,
        method="demucs",
    )
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "low_lead_level" not in reasons


def test_low_lead_level_method_aware_threshold(
    tmp_path, monkeypatch
) -> None:
    """#191: center extraction attenuates by construction, so the same
    ratio that alarms a demucs estimate stays quiet here."""
    _stub_isolation(monkeypatch, estimate_rms=0.125, method="center_extraction")
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.125,
        method="center_extraction",
    )
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "low_lead_level" not in reasons


def test_low_lead_level_needs_estimate_rms(tmp_path, monkeypatch) -> None:
    """#191: an unreadable estimate file must not produce a fake alarm —
    the check is skipped when wav_rms cannot read the path."""
    _stub_isolation(monkeypatch, estimate_rms=None, method="demucs")
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=None,
        method="demucs",
    )
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "low_lead_level" not in reasons


def test_low_lead_level_evidence_names_reachable_remedy(
    tmp_path, monkeypatch
) -> None:
    """#222: the evidence must let the UI pick the remedy that actually
    exists — a precision retry only when the standard demucs tier ran,
    and demucsAvailable so a missing addon gets an install hint, not a
    dead-end precision suggestion."""
    _stub_isolation(monkeypatch, estimate_rms=0.04, method="demucs")
    monkeypatch.setattr(pipeline, "demucs_available", lambda: True)
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True, "vocalIsolationQuality": "standard"},
        source_level=0.5,
        estimate_rms=0.04,
        method="demucs",
    )
    ev = {i["reason"]: i for i in result["reviewIssues"]}[
        "low_lead_level"
    ]["evidence"]
    assert ev["method"] == "demucs"
    assert ev["tier"] == "standard"
    assert ev["demucsAvailable"] is True
    assert ev["suggestPrecisionIsolation"] is True


def test_low_lead_level_no_retry_after_precision(
    tmp_path, monkeypatch
) -> None:
    """#222: precision already ran — there is no stronger tier left to
    suggest, so the retry flag stays off."""
    _stub_isolation(monkeypatch, estimate_rms=0.04, method="demucs")
    monkeypatch.setattr(pipeline, "demucs_available", lambda: True)
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True, "vocalIsolationQuality": "precision"},
        source_level=0.5,
        estimate_rms=0.04,
        method="demucs",
    )
    ev = {i["reason"]: i for i in result["reviewIssues"]}[
        "low_lead_level"
    ]["evidence"]
    assert ev["tier"] == "precision"
    assert ev["suggestPrecisionIsolation"] is False


def test_low_lead_level_addon_hint_when_demucs_absent(
    tmp_path, monkeypatch
) -> None:
    """#222: center extraction under a demucs-less install — the UI
    needs demucsAvailable=False to offer the addon install instead of
    a precision hint the user cannot reach."""
    _stub_isolation(
        monkeypatch, estimate_rms=0.09, method="center_extraction"
    )
    monkeypatch.setattr(pipeline, "demucs_available", lambda: False)
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.09,
        method="center_extraction",
    )
    ev = {i["reason"]: i for i in result["reviewIssues"]}[
        "low_lead_level"
    ]["evidence"]
    assert ev["method"] == "center_extraction"
    assert ev["demucsAvailable"] is False
    assert ev["suggestPrecisionIsolation"] is False


def test_low_lead_level_comb_gate_fires_on_buried_center_lead(
    tmp_path, monkeypatch
) -> None:
    """#214: the free path's RMS gate is blind to a buried lead — the
    stem stays loud on accompaniment bleed.  The comb gate convicts
    from the source: nine claimed melody notes whose own harmonics
    barely sound in the mix."""
    _stub_isolation(
        monkeypatch, estimate_rms=0.30, method="center_extraction"
    )
    monkeypatch.setattr(pipeline, "demucs_available", lambda: False)
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.30,
        method="center_extraction",
        backend=lambda _p: _comb_events(),
        # A held tone a semitone off the claimed pitch — its harmonics
        # dodge every comb band, so the "lead" owns ~0% of its spans.
        loader=_sine_loader(440.0 * 2.0 ** ((73 - 69) / 12.0)),
    )
    issues = {i["reason"]: i for i in result["reviewIssues"]}
    assert "low_lead_level" in issues
    ev = issues["low_lead_level"]["evidence"]
    assert ev["method"] == "center_extraction"
    assert ev["leadCombShare"] is not None
    assert ev["leadCombShare"] < 0.10


def test_low_lead_level_comb_gate_silent_when_lead_owns_spans(
    tmp_path, monkeypatch
) -> None:
    """#214: no false alarm when the detected melody actually sounds —
    a clean tone at the claimed pitch saturates its own comb."""
    _stub_isolation(
        monkeypatch, estimate_rms=0.30, method="center_extraction"
    )
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.30,
        method="center_extraction",
        backend=lambda _p: _comb_events(),
        loader=_sine_loader(440.0 * 2.0 ** ((72 - 69) / 12.0)),
    )
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "low_lead_level" not in reasons


def test_low_lead_level_comb_gate_needs_enough_notes(
    tmp_path, monkeypatch
) -> None:
    """#214: under the minimum-note bar the median is noise — the gate
    stays silent rather than guess."""
    _stub_isolation(
        monkeypatch, estimate_rms=0.30, method="center_extraction"
    )
    result = _run_with_source_level(
        tmp_path,
        {"vocalIsolation": True},
        source_level=0.5,
        estimate_rms=0.30,
        method="center_extraction",
        backend=lambda _p: _comb_events(count=4),
        loader=_sine_loader(440.0 * 2.0 ** ((73 - 69) / 12.0)),
    )
    reasons = {i["reason"] for i in result["reviewIssues"]}
    assert "low_lead_level" not in reasons


def _collect(tmp_path, payload_extra, monkeypatch):
    """#229: _run-shaped helper that returns the raw event stream so
    transient fields (the model-download note) are observable."""
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
        backend=None,
        loader=lambda _p: (array("f", [0.0] * (22050 * 5)), 22050),
    )
    return collected


def _stub_demucs_isolation(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline,
        "vocal_wav",
        lambda *a, **k: ("/tmp/hs-vocal.wav", "applied", True, "demucs", "4.0.1"),
    )
    monkeypatch.setattr(
        pipeline, "predict_note_events_pyin", lambda *a, **k: _events()
    )
    monkeypatch.setattr(
        pipeline, "predict_note_events_rescued", lambda *a, **k: _events()
    )


def test_model_download_note_emitted_once_before_demucs_run(
    tmp_path, monkeypatch
) -> None:
    """#229: demucs installed but weights not yet fetched -> the job
    announces the silent download stretch exactly once."""
    monkeypatch.setattr(pipeline, "demucs_available", lambda: True)
    monkeypatch.setattr(pipeline, "demucs_weights_pending", lambda: True)
    _stub_demucs_isolation(monkeypatch)
    events = _collect(
        tmp_path, {"backend": "auto", "vocalIsolation": True}, monkeypatch
    )
    notes = [e for e in events if e.get("note") == "model_download"]
    assert len(notes) == 1, events
    assert events[-1]["phase"] == "completed", events


def test_model_download_note_silent_when_weights_cached(
    tmp_path, monkeypatch
) -> None:
    """#229: weights already on disk -> no imminent download -> no
    note (a false "downloading" claim is worse than silence)."""
    monkeypatch.setattr(pipeline, "demucs_available", lambda: True)
    monkeypatch.setattr(pipeline, "demucs_weights_pending", lambda: False)
    _stub_demucs_isolation(monkeypatch)
    events = _collect(
        tmp_path, {"backend": "auto", "vocalIsolation": True}, monkeypatch
    )
    assert all("note" not in e for e in events), events
    assert events[-1]["phase"] == "completed", events


def test_model_download_note_silent_without_demucs(
    tmp_path, monkeypatch
) -> None:
    """#229: no demucs install -> the isolation runs the builtin
    extractor and no download is coming, so the note stays off."""
    monkeypatch.setattr(pipeline, "demucs_available", lambda: False)
    monkeypatch.setattr(pipeline, "demucs_weights_pending", lambda: True)
    _stub_demucs_isolation(monkeypatch)
    events = _collect(
        tmp_path, {"backend": "auto", "vocalIsolation": True}, monkeypatch
    )
    assert all("note" not in e for e in events), events
    assert events[-1]["phase"] == "completed", events
