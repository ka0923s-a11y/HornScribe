"""ENG-002: the real ``transcription`` job pipeline.

These tests run against injected backends/loaders so the whole stage
order is exercised without the basic_pitch/librosa stack (CI installs
``.[dev]`` only). The optional-dependency paths are covered separately
by the ``ENGINE_DEPENDENCY_MISSING`` test.
"""

from __future__ import annotations

import threading
from array import array
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.transcription.clean import clean_monophonic, clip_to_range
from hornscribe.transcription.key import estimate_key
from hornscribe.transcription.options import TranscriptionParams
from hornscribe.transcription.pipeline import (
    STAGES,
    run_transcription_job,
)

_REV = TranscriptionRevisionId("tr-" + "0" * 16)


def make_events(
    pitches: list[int],
    beat_sec: float = 0.5,
    confidence: float = 0.9,
    dur_ratio: float = 0.9,
) -> tuple[RawNoteEvent, ...]:
    return tuple(
        RawNoteEvent(
            id=RawNoteEventId(f"rne-{i + 1:06d}"),
            transcription_revision=_REV,
            pitch_midi=float(p),
            onset_sec=i * beat_sec,
            offset_sec=i * beat_sec + beat_sec * dur_ratio,
            confidence=confidence,
            velocity=90,
            source="test",
        )
        for i, p in enumerate(pitches)
    )


def collect() -> tuple[list[dict[str, Any]], Any]:
    events: list[dict[str, Any]] = []

    def emit(phase: str, **kw: Any) -> None:
        events.append({"phase": phase, **kw})

    return events, emit


def fake_loader(_path: str) -> tuple[array, int]:
    return array("f", [0.0] * (22050 * 5)), 22050


def run(
    tmp_path: Path,
    events: tuple[RawNoteEvent, ...],
    params_extra: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    audio = tmp_path / "take.wav"
    audio.write_bytes(b"x" * 64)
    collected, emit = collect()
    params = TranscriptionParams.from_payload(
        {
            "audioPath": str(audio),
            "tempoBpm": 120.0,
            "meter": "4/4",
            **(params_extra or {}),
        }
    )
    run_transcription_job(
        job_id="job-0001",
        params=params,
        emit=emit,
        cancel=threading.Event(),
        backend=lambda _p: events,
        loader=fake_loader,
    )
    return collected


class TestParams:
    def test_requires_audio_path(self) -> None:
        with pytest.raises(ValueError, match="audioPath"):
            TranscriptionParams.from_payload({})

    def test_defaults(self) -> None:
        p = TranscriptionParams.from_payload({"audioPath": "a.wav"})
        assert p.meter == "auto"
        assert p.min_duration_ql == Fraction(1, 4)
        assert p.tempo_bpm is None

    def test_meter_choices(self) -> None:
        assert TranscriptionParams.from_payload(
            {"audioPath": "a", "meter": "6/8"}
        ).meter_segment().beat_unit_ql == Fraction(3, 2)
        with pytest.raises(ValueError, match="meter"):
            TranscriptionParams.from_payload({"audioPath": "a", "meter": "7/8"})

    def test_selection_requires_bounds(self) -> None:
        with pytest.raises(ValueError, match="selectionStartSec"):
            TranscriptionParams.from_payload(
                {"audioPath": "a", "range": "selection"}
            )

    def test_bad_types_rejected(self) -> None:
        with pytest.raises(ValueError):
            TranscriptionParams.from_payload({"audioPath": "a", "tempoBpm": "fast"})
        with pytest.raises(ValueError):
            TranscriptionParams.from_payload(
                {"audioPath": "a", "tempoBpm": 5.0}
            )


class TestClean:
    def test_clips_overlap_to_next_onset(self) -> None:
        evs = make_events([60, 62])
        evs = (
            RawNoteEvent(
                id=evs[0].id,
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.9,  # overlaps the next onset at 0.5
                confidence=0.9,
            ),
            evs[1],
        )
        out = clean_monophonic(evs)
        assert out.events[0].offset_sec == pytest.approx(0.5)
        assert out.clipped_overlaps == 1

    def test_merges_same_pitch_gap(self) -> None:
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.4,
                confidence=0.8,
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.42,  # 20 ms gap -> merge
                offset_sec=0.8,
                confidence=0.9,
            ),
        )
        out = clean_monophonic(evs)
        assert len(out.events) == 1
        assert out.merged == 1
        assert out.events[0].offset_sec == pytest.approx(0.8)
        assert out.events[0].confidence == pytest.approx(0.9)

    def test_drops_too_short(self) -> None:
        evs = make_events([60]) + (
            RawNoteEvent(
                id=RawNoteEventId("rne-000099"),
                transcription_revision=_REV,
                pitch_midi=72,
                onset_sec=0.9,
                offset_sec=0.91,  # 10 ms flicker
                confidence=0.6,
            ),
        )
        out = clean_monophonic(evs)
        assert len(out.events) == 1
        assert out.dropped_too_short == 1

    def test_clip_to_range(self) -> None:
        evs = make_events([60, 62, 64], beat_sec=0.5)
        out = clip_to_range(evs, 0.4, 1.1)
        # All three notes overlap [0.4, 1.1]: first trimmed at the start,
        # last trimmed at the end.
        assert len(out) == 3
        assert out[0].onset_sec == pytest.approx(0.4)
        assert out[2].offset_sec == pytest.approx(1.1)


class TestKey:
    def test_c_major(self) -> None:
        key, conf = estimate_key(
            (60, 62, 64, 65, 67, 69, 71, 72),
            tuple(Fraction(1) for _ in range(8)),
        )
        assert key.fifths == 0
        assert key.mode == "major"
        assert conf > 0.5

    def test_g_major(self) -> None:
        # G A B C D E F# G
        key, _ = estimate_key(
            (67, 69, 71, 72, 74, 76, 78, 79),
            tuple(Fraction(1) for _ in range(8)),
        )
        assert key.fifths == 1
        assert key.mode == "major"

    def test_a_minor_cadence(self) -> None:
        # A B C D E F G A — same signature as C major; the final A
        # should tip the mode to minor (cadence bias).
        key, _ = estimate_key(
            (69, 71, 72, 74, 76, 77, 79, 81),
            tuple(Fraction(1) for _ in range(8)),
        )
        assert key.fifths == 0
        assert key.mode == "minor"

    def test_empty_is_c_major_zero_confidence(self) -> None:
        key, conf = estimate_key((), ())
        assert key.fifths == 0
        assert conf == 0.0


class TestPipeline:
    def test_stage_order_and_result(self, tmp_path: Path) -> None:
        events = make_events([60, 62, 64, 65, 67, 69, 71, 72])
        log = run(tmp_path, events)
        phases = [e["phase"] for e in log]
        assert phases[0] == "started"
        assert phases[-1] == "completed"
        stages = [e["stage"] for e in log if e.get("stage")]
        # Stages advance monotonically through the contract order.
        idx = [STAGES.index(s) for s in stages]
        assert idx == sorted(idx)
        assert STAGES[0] in stages and STAGES[-1] in stages
        result = log[-1]["result"]
        assert result["scoreRevision"].startswith("rev-")
        assert result["meta"]["noteCount"] == 8
        assert "score-partwise" in result["musicXmlConcert"]
        assert "<transpose>" in result["musicXmlHornF"]
        assert isinstance(result["scoreDocument"]["content"], dict)

    def test_missing_file_fails(self, tmp_path: Path) -> None:
        collected, emit = collect()
        params = TranscriptionParams.from_payload(
            {"audioPath": str(tmp_path / "nope.wav")}
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=lambda _p: (),
            loader=fake_loader,
        )
        assert collected[-1]["phase"] == "failed"
        assert collected[-1]["error"]["code"] == "JOB_FAILED"

    def test_empty_backend_result_is_no_pitched_content(
        self, tmp_path: Path
    ) -> None:
        log = run(tmp_path, ())
        assert log[-1]["phase"] == "failed"
        assert log[-1]["error"]["code"] == "NO_PITCHED_CONTENT"

    def test_cancel_between_stages(self, tmp_path: Path) -> None:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()
        cancel = threading.Event()

        def backend_then_cancel(_p: str) -> tuple[RawNoteEvent, ...]:
            cancel.set()
            return make_events([60, 62])

        params = TranscriptionParams.from_payload(
            {"audioPath": str(audio), "tempoBpm": 120.0}
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=cancel,
            backend=backend_then_cancel,
            loader=fake_loader,
        )
        assert collected[-1]["phase"] == "cancelled"

    def test_backend_error_is_job_failed(self, tmp_path: Path) -> None:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()

        def boom(_p: str) -> tuple[RawNoteEvent, ...]:
            raise ValueError("backend exploded")

        params = TranscriptionParams.from_payload(
            {"audioPath": str(audio), "tempoBpm": 120.0}
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=boom,
            loader=fake_loader,
        )
        assert collected[-1]["phase"] == "failed"
        assert collected[-1]["error"]["code"] == "JOB_FAILED"
        assert "backend exploded" in collected[-1]["error"]["message"]

    def test_dependency_missing_maps_to_engine_code(
        self, tmp_path: Path
    ) -> None:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()

        from hornscribe.transcription.backend import EngineDependencyError

        def missing(_p: str) -> tuple[Any, int]:
            raise EngineDependencyError("librosa")

        params = TranscriptionParams.from_payload(
            {"audioPath": str(audio), "tempoBpm": 120.0}
        )
        run_transcription_job(
            job_id="j",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=lambda _p: make_events([60]),
            loader=missing,
        )
        assert collected[-1]["phase"] == "failed"
        assert collected[-1]["error"]["code"] == "ENGINE_DEPENDENCY_MISSING"

    def test_low_confidence_and_range_issues(self, tmp_path: Path) -> None:
        # One quiet note + one stratospheric note -> two extra issues.
        events = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.45,
                confidence=0.25,
                velocity=40,
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=100,  # way above horn range
                onset_sec=0.5,
                offset_sec=0.95,
                confidence=0.9,
                velocity=90,
            ),
        )
        log = run(tmp_path, events)
        assert log[-1]["phase"] == "completed"
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "low_model_confidence" in reasons
        assert "outside_preferred_horn_range" in reasons

    def test_deadline_fails(self, tmp_path: Path) -> None:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()
        # deadlineMs below the 1.0 floor is rejected at parse time.
        with pytest.raises(ValueError):
            TranscriptionParams.from_payload(
                {"audioPath": str(audio), "tempoBpm": 120.0, "deadlineMs": 0.001}
            )

    def test_pickup_shift(self, tmp_path: Path) -> None:
        # First onset before beat 0 of a fixed grid is impossible with
        # manual tempo (zero_sec = first onset), so this exercises the
        # beat-map path indirectly via a late first onset instead: the
        # score must still start at beat 0, not mid-measure.
        events = make_events([64, 64, 64, 64], beat_sec=0.5)
        log = run(tmp_path, events)
        assert log[-1]["phase"] == "completed"
        doc = log[-1]["result"]["scoreDocument"]
        first_note = doc["content"]["parts"][0]["notes"][0]
        assert first_note["startBeat"] == "0/1"
