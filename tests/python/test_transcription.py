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
from hornscribe.transcription.meter import estimate_meter
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
            TranscriptionParams.from_payload({"audioPath": "a", "meter": "5/8"})

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

    def test_backend_choice_validated_and_echoed(self) -> None:
        # #108: the settings backend selector reaches the engine and
        # is echoed in meta.settings.
        p = TranscriptionParams.from_payload(
            {"audioPath": "a", "backend": "basicPitch"}
        )
        assert p.backend == "basicPitch"
        assert p.settings_dict()["backend"] == "basicPitch"
        assert TranscriptionParams.from_payload({"audioPath": "a"}).backend == "auto"
        with pytest.raises(ValueError, match="backend"):
            TranscriptionParams.from_payload({"audioPath": "a", "backend": "whisper"})

    def test_texture_choice_validated_and_echoed(self) -> None:
        # Melody texture keeps the top voice on overlaps (JPOP/mix
        # sources); the choice is echoed in meta.settings.
        p = TranscriptionParams.from_payload(
            {"audioPath": "a", "texture": "melody"}
        )
        assert p.texture == "melody"
        assert p.settings_dict()["texture"] == "melody"
        assert TranscriptionParams.from_payload(
            {"audioPath": "a", "texture": "voices"}
        ).texture == "voices"
        assert TranscriptionParams.from_payload({"audioPath": "a"}).texture == "auto"
        with pytest.raises(ValueError, match="texture"):
            TranscriptionParams.from_payload({"audioPath": "a", "texture": "chord"})


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

    def test_octave_flicker_corrected(self) -> None:
        # C4, C5 (octave ghost), C4 — both neighbours agree on pitch
        # class and the middle note is exactly +12: snap it back.
        evs = make_events([60, 72, 60], beat_sec=0.5)
        out = clean_monophonic(evs)
        assert out.octave_corrected == 1
        assert [int(e.pitch_midi) for e in out.events] == [60, 60, 60]

    def test_real_octave_leap_untouched(self) -> None:
        # C4, C5, G4 — neighbours disagree on pitch class, so the
        # octave jump is a real leap and must survive.
        evs = make_events([60, 72, 67], beat_sec=0.5)
        out = clean_monophonic(evs)
        assert out.octave_corrected == 0
        assert [int(e.pitch_midi) for e in out.events] == [60, 72, 67]

    def test_harmonic_ghost_dropped_not_clipped(self) -> None:
        # A short, weaker octave-up note starting under a sustained
        # note is an overtone artifact: drop the ghost and keep the
        # real note's tail instead of clipping at the ghost onset.
        sustained = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=0.9,
            confidence=0.9,
        )
        ghost = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=72,  # octave up
            onset_sec=0.3,
            offset_sec=0.38,  # 80 ms — under the ghost cap
            confidence=0.5,  # weaker than the sustained note
        )
        out = clean_monophonic((sustained, ghost))
        assert len(out.events) == 1
        assert out.events[0].offset_sec == pytest.approx(0.9)
        assert out.ghost_dropped == 1
        assert out.clipped_overlaps == 0

    def test_strong_overlap_still_clips(self) -> None:
        # Same shape as the ghost case but equal confidence and a
        # non-harmonic interval — a real second voice, so the
        # monophonic clip still applies and the warning counts.
        sustained = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=0.9,
            confidence=0.5,
        )
        second = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=62,  # whole step — not a harmonic interval
            onset_sec=0.3,
            offset_sec=0.6,
            confidence=0.9,
        )
        out = clean_monophonic((sustained, second))
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(0.3)
        assert out.clipped_overlaps == 1
        assert out.polyphonic_overlaps == 1
        assert out.ghost_dropped == 0

    def test_melody_prefer_drops_lower_overlap(self) -> None:
        # Melody mode: a lower accompaniment hypothesis overlapping a
        # sustained higher note loses entirely — the melody tail is
        # never clipped. Interval of 21 semitones is not a ghost shape.
        melody = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=0.9,
            confidence=0.9,
        )
        accomp = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=55,
            onset_sec=0.3,
            offset_sec=0.6,
            confidence=0.9,
        )
        out = clean_monophonic((melody, accomp), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].offset_sec == pytest.approx(0.9)
        assert out.clipped_overlaps == 0
        assert out.polyphonic_overlaps == 1

    def test_melody_prefer_higher_overlap_cuts_in(self) -> None:
        # A higher hypothesis overlapping a lower note still cuts in
        # at its own onset — the top voice always wins.
        low = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=55,
            onset_sec=0.0,
            offset_sec=0.9,
            confidence=0.9,
        )
        high = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.3,
            offset_sec=0.6,
            confidence=0.9,
        )
        out = clean_monophonic((low, high), prefer="top")
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(0.3)
        assert int(out.events[1].pitch_midi) == 76
        assert out.clipped_overlaps == 1

    def test_melody_prefer_still_drops_ghost(self) -> None:
        # Ghost suppression runs before the prefer rule: a short,
        # weaker octave-up overlap is an overtone artifact, not the
        # melody — it must not cut the sustained note's tail.
        sustained = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=0.9,
            confidence=0.9,
        )
        ghost = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=72,
            onset_sec=0.3,
            offset_sec=0.38,
            confidence=0.5,
        )
        out = clean_monophonic((sustained, ghost), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].offset_sec == pytest.approx(0.9)
        assert out.ghost_dropped == 1

    def test_prefer_rejects_unknown_value(self) -> None:
        with pytest.raises(ValueError, match="prefer"):
            clean_monophonic(make_events([60]), prefer="loud")


class TestSplitVoices:
    """#85: polyphonic input partitions into two monophonic streams."""

    def _ev(
        self,
        i: int,
        pitch: float,
        onset: float,
        offset: float,
        confidence: float = 0.9,
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=pitch,
            onset_sec=onset,
            offset_sec=offset,
            confidence=confidence,
            velocity=90,
            source="test",
        )

    def test_two_overlapping_lines_split(self) -> None:
        from hornscribe.transcription.clean import split_voices

        events = (
            self._ev(1, 60, 0.0, 1.0),   # sustained low note
            self._ev(2, 72, 0.1, 0.5),   # melody note over it
            self._ev(3, 74, 0.5, 0.9),   # next melody note
        )
        out = split_voices(events)
        assert len(out.voices[0]) == 2   # melody line (higher median)
        assert len(out.voices[1]) == 1   # sustained low note
        assert [e.pitch_midi for e in out.voices[0]] == [72.0, 74.0]
        assert out.voices[1][0].pitch_midi == 60.0
        assert out.dropped_beyond_voices == 0

    def test_monophonic_input_stays_one_voice(self) -> None:
        from hornscribe.transcription.clean import split_voices

        out = split_voices(make_events([60, 62, 64]))
        assert len(out.voices[0]) == 3
        assert out.voices[1] == ()
        assert out.dropped_beyond_voices == 0

    def test_third_simultaneous_voice_is_dropped_and_counted(self) -> None:
        from hornscribe.transcription.clean import split_voices

        events = (
            self._ev(1, 48, 0.0, 1.0),
            self._ev(2, 60, 0.0, 1.0),
            self._ev(3, 72, 0.2, 0.8),   # fits neither voice
        )
        out = split_voices(events)
        assert len(out.voices[0]) + len(out.voices[1]) == 2
        assert out.dropped_beyond_voices == 1

    def test_same_pitch_merges_within_its_own_voice(self) -> None:
        from hornscribe.transcription.clean import split_voices

        events = (
            self._ev(1, 60, 0.0, 0.4),
            self._ev(2, 60, 0.42, 0.8),  # 20 ms gap -> merges in voice 1
        )
        out = split_voices(events)
        assert len(out.voices[0]) == 1
        assert out.voices[0][0].offset_sec == pytest.approx(0.8)
        assert out.merged == 1

    def test_harmonic_ghost_does_not_claim_the_second_voice(self) -> None:
        from hornscribe.transcription.clean import split_voices

        sustained = self._ev(1, 60, 0.0, 1.0, confidence=0.9)
        ghost = self._ev(2, 72, 0.4, 0.48, confidence=0.4)  # short +12 overtone
        out = split_voices((sustained, ghost))
        assert out.ghost_dropped == 1
        assert out.dropped_beyond_voices == 0
        assert len(out.voices[0]) == 1
        assert out.voices[1] == ()

    def test_upper_voice_leads_by_median_pitch(self) -> None:
        from hornscribe.transcription.clean import split_voices

        # Low sustained line starts first, melody joins after — the
        # higher-median stream must still land in voices[0].
        events = (
            self._ev(1, 50, 0.0, 2.0),
            self._ev(2, 72, 0.5, 0.9),
            self._ev(3, 74, 1.0, 1.4),
        )
        out = split_voices(events)
        assert [e.pitch_midi for e in out.voices[0]] == [72.0, 74.0]
        assert [e.pitch_midi for e in out.voices[1]] == [50.0]


class TestMeter:
    def _beats(self, n: int, period: float = 0.5) -> tuple[float, ...]:
        return tuple(i * period for i in range(n))

    def test_three_four(self) -> None:
        # Accents every 3rd beat.
        n = 24
        strengths = tuple(3.0 if i % 3 == 0 else 1.0 for i in range(n))
        est = estimate_meter(self._beats(n), strengths)
        assert est.meter == "3/4"
        assert not est.uncertain

    def test_four_four(self) -> None:
        n = 24
        strengths = tuple(3.0 if i % 4 == 0 else 1.0 for i in range(n))
        est = estimate_meter(self._beats(n), strengths)
        assert est.meter == "4/4"

    def test_six_eight(self) -> None:
        # Eighth-note pulse with accents at lag 6 and a mid-bar accent
        # at lag 3 — the two dotted-quarter beats of 6/8.
        n = 36
        strengths = tuple(
            3.0 if i % 6 == 0 else (1.4 if i % 3 == 0 else 1.0)
            for i in range(n)
        )
        est = estimate_meter(self._beats(n, period=0.25), strengths)
        assert est.meter == "6/8"
        assert est.tracked_eighths

    def test_five_four(self) -> None:
        # Accents every 5th beat — the odd-meter extension must be
        # scorable by auto estimation, not just explicit selection.
        n = 30
        strengths = tuple(3.0 if i % 5 == 0 else 1.0 for i in range(n))
        est = estimate_meter(self._beats(n), strengths)
        assert est.meter == "5/4"
        assert not est.tracked_eighths

    def test_nine_eight(self) -> None:
        # Eighth pulse: downbeat every 9 eighths with the three
        # dotted-quarter group accents at lags 3 and 6.
        n = 45
        strengths = tuple(
            3.0 if i % 9 == 0 else (1.4 if i % 3 == 0 else 1.0)
            for i in range(n)
        )
        est = estimate_meter(self._beats(n, period=0.25), strengths)
        assert est.meter == "9/8"
        assert est.tracked_eighths

    def test_twelve_eight(self) -> None:
        # Eighth pulse: downbeat every 12 eighths, mid-bar accent at
        # lag 6 clearly weaker than the downbeat (equal = 6/8).
        n = 48
        strengths = tuple(
            3.0 if i % 12 == 0 else (1.4 if i % 3 == 0 else 1.0)
            for i in range(n)
        )
        est = estimate_meter(self._beats(n, period=0.25), strengths)
        assert est.meter == "12/8"
        assert est.tracked_eighths

    def test_seven_eight(self) -> None:
        # Eighth pulse with a strong accent every 7 eighths that beats
        # the compound-meter lag evidence.
        n = 42
        strengths = tuple(3.0 if i % 7 == 0 else 1.0 for i in range(n))
        est = estimate_meter(self._beats(n, period=0.25), strengths)
        assert est.meter == "7/8"
        assert est.tracked_eighths

    def test_too_few_beats_uncertain(self) -> None:
        est = estimate_meter(self._beats(4), (1.0, 1.0, 1.0, 1.0))
        assert est.meter == "4/4"
        assert est.uncertain

    def test_flat_strengths_uncertain(self) -> None:
        n = 16
        est = estimate_meter(self._beats(n), tuple(1.0 for _ in range(n)))
        assert est.meter == "4/4"
        assert est.uncertain


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

    def test_auto_texture_falls_back_to_melody_on_mix(
        self, tmp_path: Path
    ) -> None:
        # A melody line with a lower accompaniment hypothesis under
        # every note: onset-clean clips the melody tails, auto texture
        # detects the overlap density and re-cleans keeping the top
        # voice — the melody survives intact.
        events: list[RawNoteEvent] = []
        for i in range(8):
            events.append(
                RawNoteEvent(
                    id=RawNoteEventId(f"rne-{i * 2 + 1:06d}"),
                    transcription_revision=_REV,
                    pitch_midi=76.0,
                    onset_sec=i * 0.5,
                    offset_sec=i * 0.5 + 0.45,
                    confidence=0.9,
                )
            )
            events.append(
                RawNoteEvent(
                    id=RawNoteEventId(f"rne-{i * 2 + 2:06d}"),
                    transcription_revision=_REV,
                    pitch_midi=55.0,
                    onset_sec=i * 0.5 + 0.2,
                    offset_sec=i * 0.5 + 0.4,
                    confidence=0.9,
                )
            )
        log = run(tmp_path, tuple(events))
        assert log[-1]["phase"] == "completed"
        assert log[-1]["result"]["meta"]["noteCount"] == 8
        log_mono = run(tmp_path, tuple(events), {"texture": "mono"})
        assert log_mono[-1]["phase"] == "completed"
        assert log_mono[-1]["result"]["meta"]["noteCount"] == 16

    def test_voices_texture_keeps_two_parts(self, tmp_path: Path) -> None:
        # #85: a duet — sustained lower line under a melody — becomes a
        # two-part score instead of collapsing to one line. Canonical
        # ids stay unique across parts and both MusicXML bodies carry
        # both staves.
        events: list[RawNoteEvent] = []
        for i in range(8):
            events.append(
                RawNoteEvent(
                    id=RawNoteEventId(f"rne-{i * 2 + 1:06d}"),
                    transcription_revision=_REV,
                    pitch_midi=76.0,
                    onset_sec=i * 0.5,
                    offset_sec=i * 0.5 + 0.45,
                    confidence=0.9,
                )
            )
            events.append(
                RawNoteEvent(
                    id=RawNoteEventId(f"rne-{i * 2 + 2:06d}"),
                    transcription_revision=_REV,
                    pitch_midi=55.0,
                    onset_sec=i * 0.5 + 0.2,
                    offset_sec=i * 0.5 + 0.4,
                    confidence=0.9,
                )
            )
        log = run(tmp_path, tuple(events), {"texture": "voices"})
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 2
        ids = [n["id"] for p in parts for n in p["notes"]]
        assert len(ids) == len(set(ids))
        assert result["meta"]["partCount"] == 2
        assert result["meta"]["noteCount"] == len(ids)
        # Both parts reach both presentations.
        assert result["musicXmlConcert"].count("<part ") == 2
        assert result["musicXmlHornF"].count("<part ") == 2
        # The split is reported, not silent.
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "overlapping_candidates" in reasons
