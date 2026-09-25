"""ENG-002: the real ``transcription`` job pipeline.

These tests run against injected backends/loaders so the whole stage
order is exercised without the basic_pitch/librosa stack (CI installs
``.[dev]`` only). The optional-dependency paths are covered separately
by the ``ENGINE_DEPENDENCY_MISSING`` test.
"""

from __future__ import annotations

import threading
import wave
from array import array
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from hornscribe.domain.events import PitchBendPoint, RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.transcription.clean import clean_monophonic, clip_to_range
from hornscribe.transcription.key import estimate_key, estimate_key_segments
from hornscribe.transcription.meter import estimate_meter
from hornscribe.transcription.options import TranscriptionParams
from hornscribe.transcription.pipeline import (
    STAGES,
    run_transcription_job,
)
from hornscribe.transcription.swing import detect_swing

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

    def test_display_name_parsed(self) -> None:
        # #305: the user's file name rides separately from audioPath
        # so a staged temp path never becomes the score title.
        p = TranscriptionParams.from_payload(
            {"audioPath": "staged-1-take.wav", "displayName": "take.wav"}
        )
        assert p.display_name == "take.wav"
        # Absent / non-string / blank all collapse to None.
        assert (
            TranscriptionParams.from_payload({"audioPath": "a"}).display_name
            is None
        )
        assert (
            TranscriptionParams.from_payload(
                {"audioPath": "a", "displayName": 42}
            ).display_name
            is None
        )
        assert (
            TranscriptionParams.from_payload(
                {"audioPath": "a", "displayName": "   "},
            ).display_name
            is None
        )

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

    def test_merge_keeps_bend_evidence(self) -> None:
        # #192: stitched same-pitch detections keep both bend series.
        bend = PitchBendPoint
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.4,
                confidence=0.8,
                pitch_bends=(bend(0.1, 0.0), bend(0.3, 0.5)),
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.42,
                offset_sec=0.8,
                confidence=0.9,
                pitch_bends=(bend(0.5, -0.2), bend(0.7, 0.1)),
            ),
        )
        out = clean_monophonic(evs)
        assert len(out.events) == 1
        assert len(out.events[0].pitch_bends) == 4

    def test_clip_keeps_only_in_span_bends(self) -> None:
        # #192: clipping drops bend points past the new offset.
        bend = PitchBendPoint
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.9,
                confidence=0.9,
                pitch_bends=(bend(0.1, 0.0), bend(0.8, 0.5)),
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=62,
                onset_sec=0.5,
                offset_sec=0.9,
                confidence=0.9,
            ),
        )
        out = clean_monophonic(evs)
        assert out.events[0].offset_sec == pytest.approx(0.5)
        assert [b.time_sec for b in out.events[0].pitch_bends] == [0.1]

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

    def test_harmonic_ghost_under_a_lower_voice_is_dropped(self) -> None:
        # #85: the ghost check watched only the upper voice — a ghost
        # riding on the lower sustained line still claimed a free slot.
        from hornscribe.transcription.clean import split_voices

        upper = self._ev(1, 76, 0.0, 1.0, confidence=0.9)
        lower = self._ev(2, 48, 0.0, 1.0, confidence=0.9)
        ghost = self._ev(3, 60, 0.4, 0.48, confidence=0.4)  # +12 over lower
        out = split_voices((upper, lower, ghost))
        assert out.ghost_dropped == 1
        assert out.dropped_beyond_voices == 0
        assert sum(len(v) for v in out.voices) == 2

    def test_crossing_lines_keep_their_own_voice(self) -> None:
        # #85: free voices are chosen by pitch proximity, so a line
        # that dips under a held note still continues its own stream
        # instead of stealing the other slot.
        from hornscribe.transcription.clean import split_voices

        events = (
            self._ev(1, 72, 0.0, 0.4),   # upper line starts high
            self._ev(2, 60, 0.1, 2.0),   # lower line holds long
            self._ev(3, 74, 0.5, 0.9),   # upper line continues
        )
        out = split_voices(events, max_voices=2)
        assert out.dropped_beyond_voices == 0
        upper = [e.pitch_midi for e in out.voices[0]]
        lower = [e.pitch_midi for e in out.voices[1]]
        assert upper == [72.0, 74.0]
        assert lower == [60.0]

    def test_free_voice_picked_by_pitch_proximity(self) -> None:
        # #85: when both slots are free the event continues the line
        # whose last pitch is nearer — slot-order assignment used to
        # park it in the upper voice and break the low line.
        from hornscribe.transcription.clean import split_voices

        events = (
            self._ev(1, 72, 0.0, 0.4),   # upper line
            self._ev(2, 60, 0.0, 0.4),   # lower line (simultaneous)
            self._ev(3, 62, 0.5, 0.9),   # continues the low line
        )
        out = split_voices(events, max_voices=2)
        assert out.dropped_beyond_voices == 0
        upper = [e.pitch_midi for e in out.voices[0]]
        lower = [e.pitch_midi for e in out.voices[1]]
        assert upper == [72.0]
        assert lower == [60.0, 62.0]

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


class TestKeySegments:
    """#133: mid-piece modulation detection over measure histograms."""

    def _run(
        self,
        notes: list[tuple[int, Fraction, Fraction]],
        measure_len: Fraction = Fraction(4),
    ) -> tuple[object, tuple, float]:
        pitches = tuple(p for p, _o, _d in notes)
        onsets = tuple(o for _p, o, _d in notes)
        durs = tuple(d for _p, _o, d in notes)
        end = max((o + d for _p, o, d in notes), default=Fraction(0))
        starts = [Fraction(0)]
        pos = measure_len
        while pos <= end:
            starts.append(pos)
            pos += measure_len
        return estimate_key_segments(pitches, onsets, durs, tuple(starts))

    def _scale(self, root: int, start: Fraction, measures: int) -> list:
        # Ascending major scale resolving to the tonic, one note per
        # beat, 8 notes per 2-measure cycle — each segment cadences on
        # the root so the cadence bias reads the real tonic.
        degs = (0, 2, 4, 5, 7, 9, 11, 12)
        out = []
        for i in range(measures * 4):
            out.append(
                (root + degs[i % 8], start + i, Fraction(1))
            )
        return out

    def test_single_key_returns_no_changes(self) -> None:
        head, changes, conf = self._run(self._scale(60, Fraction(0), 8))
        assert changes == ()
        assert head.fifths == 0
        assert conf > 0.5

    def test_modulation_detected_at_measure_boundary(self) -> None:
        # 16 measures of C major then 16 of Db major — a classic
        # last-chorus half-step lift.
        notes = self._scale(60, Fraction(0), 16) + self._scale(
            61, Fraction(64), 16
        )
        head, changes, conf = self._run(notes)
        assert len(changes) == 2
        assert changes[0].start_beat == 0
        assert changes[0].key_signature.fifths == 0
        assert changes[1].start_beat == Fraction(64)
        assert changes[1].key_signature.fifths == -5
        assert head == changes[0].key_signature

    def test_short_piece_falls_back_to_single_key(self) -> None:
        notes = self._scale(60, Fraction(0), 3)
        head, changes, _ = self._run(notes)
        assert changes == ()
        assert head.fifths == 0

    def test_empty_input(self) -> None:
        head, changes, conf = estimate_key_segments((), (), (), (Fraction(0),))
        assert changes == ()
        assert head.fifths == 0
        assert conf == 0.0


class TestSwing:
    """#134: offbeat onset census -> swing_feel review issue."""

    def _events(self, onsets: list[float]) -> tuple:
        return tuple(
            RawNoteEvent(
                id=RawNoteEventId(f"rne-{i + 1:06d}"),
                transcription_revision=_REV,
                pitch_midi=60 + (i % 7),
                onset_sec=t,
                offset_sec=t + 0.3,
                confidence=0.9,
                velocity=90,
            )
            for i, t in enumerate(onsets)
        )

    def test_offbeat_census(self) -> None:
        # Quarter-note beats (QL): offbeats at 2/3 of a beat.
        onsets = [
            Fraction(i) + Fraction(2, 3) if i % 2 else Fraction(i)
            for i in range(40)
        ]
        est = detect_swing(tuple(onsets))
        assert est.detected
        assert est.offbeats == 20
        assert est.swing == 20
        assert est.mean_phase == Fraction(2, 3)

    def test_straight_eighths_not_swing(self) -> None:
        onsets = [Fraction(i, 2) for i in range(80)]  # eighths on the half beat
        est = detect_swing(tuple(onsets))
        assert not est.detected
        assert est.straight == 40

    def test_true_triplets_not_swing(self) -> None:
        # Both 1/3 and 2/3 clusters occupied -> triplet writing.
        onsets = []
        for b in range(24):
            onsets += [Fraction(b), Fraction(b) + Fraction(1, 3), Fraction(b) + Fraction(2, 3)]
        est = detect_swing(tuple(onsets))
        assert not est.detected
        assert est.triplet == 24

    def test_pipeline_emits_swing_issue(self, tmp_path: Path) -> None:
        # 120bpm -> 0.5s per quarter beat; offbeats at 2/3 of the beat.
        onsets = [
            i * 0.5 + (2.0 / 3.0) * 0.5 if i % 2 else i * 0.5
            for i in range(40)
        ]
        log = run(tmp_path, self._events(onsets))
        assert log[-1]["phase"] == "completed"
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "swing_feel" in reasons

    def test_pipeline_writes_swing_notation(
        self, tmp_path: Path
    ) -> None:
        # #134: a detected shuffle lands on the payload (swingFeel) and
        # the MusicXML carries a swing direction with the detected
        # ratio as the playback hint.
        onsets = [
            i * 0.5 + (2.0 / 3.0) * 0.5 if i % 2 else i * 0.5
            for i in range(40)
        ]
        log = run(tmp_path, self._events(onsets))
        result = log[-1]["result"]
        assert result["scoreDocument"]["content"]["swingFeel"] == "2/3"
        xml = result["musicXmlConcert"]
        assert "<swing>" in xml
        assert "<first>2</first>" in xml
        assert "<second>1</second>" in xml
        # The horn presentation carries the same marking.
        assert "<swing>" in result["musicXmlHornF"]

    def test_pipeline_straight_no_swing_notation(
        self, tmp_path: Path
    ) -> None:
        log = run(tmp_path, self._events([i * 0.25 for i in range(40)]))
        result = log[-1]["result"]
        assert "swingFeel" not in result["scoreDocument"]["content"]
        assert "<swing>" not in result["musicXmlConcert"]

    def test_pyin_under_polyphonic_texture_warns(
        self, tmp_path: Path
    ) -> None:
        # #181: pYIN is monophonic — texture=voices must surface that
        # the result is one line by construction.
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "pyin", "texture": "voices"},
        )
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "monophonic_backend" in reasons

    def test_pyin_under_auto_texture_warns(self, tmp_path: Path) -> None:
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "pyin", "texture": "auto"},
        )
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "monophonic_backend" in reasons

    def test_pyin_under_mono_texture_no_warn(
        self, tmp_path: Path
    ) -> None:
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "pyin", "texture": "mono"},
        )
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "monophonic_backend" not in reasons

    def test_pyin_warn_offers_basic_pitch_rerun(
        self, tmp_path: Path
    ) -> None:
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "pyin", "texture": "voices"},
        )
        mono = [
            i
            for i in log[-1]["result"]["reviewIssues"]
            if i["reason"] == "monophonic_backend"
        ]
        assert mono[0]["evidence"]["suggestBasicPitch"] is True

    def test_score_document_records_resolved_backend(
        self, tmp_path: Path
    ) -> None:
        # Provenance: the ScoreDocument must name the engine that ran,
        # not a hardcoded basic_pitch.
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "pyin", "texture": "mono"},
        )
        doc = log[-1]["result"]["scoreDocument"]
        assert doc["transcriptionBackend"] == "pyin"
        assert log[-1]["result"]["meta"]["backend"] == "pyin"

    def test_auto_backend_resolves_pyin_for_mono(
        self, tmp_path: Path
    ) -> None:
        # #189: "auto" picks the engine that fits the declared
        # texture — a declared-mono source gets the tracker.
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "auto", "texture": "mono"},
        )
        result = log[-1]["result"]
        assert result["meta"]["backend"] == "pyin"
        assert result["scoreDocument"]["transcriptionBackend"] == "pyin"
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "monophonic_backend" not in reasons

    def test_basic_pitch_under_voices_no_warn(
        self, tmp_path: Path
    ) -> None:
        log = run(
            tmp_path,
            self._events([i * 0.5 for i in range(8)]),
            {"backend": "basicPitch", "texture": "voices"},
        )
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "monophonic_backend" not in reasons

    def test_pipeline_straight_no_issue(self, tmp_path: Path) -> None:
        log = run(tmp_path, self._events([i * 0.25 for i in range(40)]))
        assert log[-1]["phase"] == "completed"
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "swing_feel" not in reasons


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

    def test_auto_texture_suggests_voices_retry(
        self, tmp_path: Path
    ) -> None:
        # #148: auto detected a dense mix — the overlap warning carries
        # suggestVoicesTexture so the UI can offer a one-click re-run
        # with the voices texture. #200: an explicit mono choice with
        # the same overlap density gets the suggestion too — declaring
        # mono on a real mix is exactly the case the remedy exists for.
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
        result = run(tmp_path, tuple(events))[-1]["result"]
        merged = [
            i
            for i in result["reviewIssues"]
            if i["reason"] == "overlapping_candidates"
            and "polyphonicOverlaps" in i["evidence"]
        ]
        assert merged
        assert merged[0]["evidence"]["suggestVoicesTexture"] is True
        mono = run(tmp_path, tuple(events), {"texture": "mono"})[-1][
            "result"
        ]
        merged_mono = [
            i
            for i in mono["reviewIssues"]
            if i["reason"] == "overlapping_candidates"
            and "polyphonicOverlaps" in i["evidence"]
        ]
        assert merged_mono
        assert merged_mono[0]["evidence"]["suggestVoicesTexture"] is True

        # #200: melody intentionally folds accompaniment into the top
        # line — the voices suggestion would contradict the declared
        # intent, so it stays off there.
        melody = run(tmp_path, tuple(events), {"texture": "melody"})[-1][
            "result"
        ]
        merged_melody = [
            i
            for i in melody["reviewIssues"]
            if i["reason"] == "overlapping_candidates"
            and "polyphonicOverlaps" in i["evidence"]
        ]
        assert merged_melody
        assert merged_melody[0]["evidence"]["suggestVoicesTexture"] is False

    def test_mix_suggests_vocal_isolation_until_used(
        self, tmp_path: Path
    ) -> None:
        # #314: a lead-vocal mix (the common JPOP case) wants the
        # melody isolated, not every detected line — the overlap
        # issue also carries suggestVocalIsolation so the UI can
        # offer the one-click vocal-isolation re-run. It stays off
        # once isolation already ran (re-suggesting would be noise).
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

        def _issue(res):
            return [
                i
                for i in res["reviewIssues"]
                if i["reason"] == "overlapping_candidates"
                and "polyphonicOverlaps" in i["evidence"]
            ][0]

        plain = run(tmp_path, tuple(events))[-1]["result"]
        assert _issue(plain)["evidence"]["suggestVocalIsolation"] is True

        isolated = run(
            tmp_path, tuple(events), {"vocalIsolation": True}
        )[-1]["result"]
        assert (
            _issue(isolated)["evidence"]["suggestVocalIsolation"] is False
        )

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

    def test_chords_texture_names_the_part_as_chords(
        self, tmp_path: Path
    ) -> None:
        # #251: the chords texture is an analytical capture of
        # simultaneous notes, not a one-player part — the exported
        # part name must say so instead of claiming a plain solo part.
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
        log = run(tmp_path, tuple(events), {"texture": "chords"})
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 1
        assert parts[0]["name"] == "Horn in F (chords)"
        assert "Horn in F (chords)" in result["musicXmlConcert"]

    def test_voices_texture_keeps_three_parts(self, tmp_path: Path) -> None:
        # #85: a triad texture — melody + mid + bass — becomes a
        # three-part score; nothing past three voices is silently
        # dropped (droppedBeyondVoices stays 0 here).
        events: list[RawNoteEvent] = []
        for i in range(8):
            for lane, pitch in enumerate((76.0, 64.0, 48.0)):
                events.append(
                    RawNoteEvent(
                        id=RawNoteEventId(f"rne-{i * 3 + lane + 1:06d}"),
                        transcription_revision=_REV,
                        pitch_midi=pitch,
                        onset_sec=i * 0.5 + lane * 0.05,
                        offset_sec=i * 0.5 + 0.45,
                        confidence=0.9,
                    )
                )
        log = run(tmp_path, tuple(events), {"texture": "voices"})
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 3
        assert [p["name"] for p in parts] == [
            "Horn in F",
            "Horn in F (2nd voice)",
            "Horn in F (voice 3)",
        ]
        ids = [n["id"] for p in parts for n in p["notes"]]
        assert len(ids) == len(set(ids))
        assert result["musicXmlConcert"].count("<part ") == 3
        overlap = [
            i for i in result["reviewIssues"]
            if i["reason"] == "overlapping_candidates"
        ]
        assert overlap
        assert overlap[0]["evidence"]["voiceCounts"][0] > 0


class TestSelectionStaging:
    """#229: a selection job stages only the chosen span for the backend.

    The backend contract is "events are relative to the file it read",
    so the pipeline shifts them back to absolute source seconds — the
    review/seek timeline never moves.
    """

    def _run(
        self,
        tmp_path: Path,
        events: tuple[RawNoteEvent, ...],
        params_extra: dict[str, Any],
        backend: Any | None = None,
    ) -> list[dict[str, Any]]:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()
        params = TranscriptionParams.from_payload(
            {
                "audioPath": str(audio),
                "tempoBpm": 120.0,
                "meter": "4/4",
                **params_extra,
            }
        )
        run_transcription_job(
            job_id="job-sel",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=backend or (lambda _p: events),
            loader=lambda _p: (array("f", [0.0] * (22050 * 10)), 22050),
        )
        return collected

    def test_backend_gets_staged_slice_not_full_file(self, tmp_path: Path) -> None:
        seen: dict[str, Any] = {}

        def backend(path: str) -> tuple[RawNoteEvent, ...]:
            seen["path"] = path
            with wave.open(path, "rb") as wav:
                seen["frames"] = wav.getnframes()
                seen["rate"] = wav.getframerate()
                seen["channels"] = wav.getnchannels()
            return make_events([60, 62, 64])

        log = self._run(
            tmp_path,
            (),
            {
                "range": "selection",
                "selectionStartSec": 2.0,
                "selectionEndSec": 4.0,
            },
            backend=backend,
        )
        assert log[-1]["phase"] == "completed"
        # The staged file is a temp WAV, not the source path, and it
        # holds only the 2 s selection — inference never sees the rest.
        assert seen["path"] != str(tmp_path / "take.wav")
        assert seen["path"].endswith(".wav")
        assert seen["frames"] == 2 * 22050
        assert seen["rate"] == 22050
        assert seen["channels"] == 1
        # The temp file is removed after the blocking backend call.
        assert not Path(seen["path"]).exists()

    def test_slice_relative_events_shift_to_source_seconds(
        self, tmp_path: Path
    ) -> None:
        # Backend returns events relative to the slice it read; the
        # pipeline must re-anchor them so review seek targets stay on
        # the original timeline (confidence 0.3 -> issue carries the
        # event's absolute timeRange).
        log = self._run(
            tmp_path,
            make_events([60, 62, 64], confidence=0.3),
            {
                "range": "selection",
                "selectionStartSec": 2.0,
                "selectionEndSec": 4.0,
            },
        )
        assert log[-1]["phase"] == "completed"
        issues = log[-1]["result"]["reviewIssues"]
        low_conf = [
            i for i in issues if i["reason"] == "low_model_confidence"
        ]
        # Slice-relative onsets 0.0/0.5/1.0 land on absolute 2.0/2.5/3.0.
        assert [i["timeRange"]["startSec"] for i in low_conf] == [
            pytest.approx(t) for t in (2.0, 2.5, 3.0)
        ]
        # The selection stays recorded in the settings echo.
        settings = log[-1]["result"]["meta"]["settings"]
        assert settings["selectionStartSec"] == 2.0
        assert settings["selectionEndSec"] == 4.0

    def test_staging_failure_falls_back_to_full_audio(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import hornscribe.transcription.pipeline as pipeline_mod

        monkeypatch.setattr(
            pipeline_mod, "_stage_selection_wav", lambda _s, _r: None
        )
        seen: dict[str, Any] = {}
        # Full-audio events are already absolute — place them inside
        # the [2, 4] selection so clip_to_range keeps them.
        abs_events = tuple(
            replace(
                e,
                onset_sec=e.onset_sec + 2.5,
                offset_sec=e.offset_sec + 2.5,
            )
            for e in make_events([60, 62, 64], confidence=0.3)
        )

        def backend(path: str) -> tuple[RawNoteEvent, ...]:
            seen["path"] = path
            return abs_events

        log = self._run(
            tmp_path,
            (),
            {
                "range": "selection",
                "selectionStartSec": 2.0,
                "selectionEndSec": 4.0,
            },
            backend=backend,
        )
        assert log[-1]["phase"] == "completed"
        assert seen["path"] == str(tmp_path / "take.wav")
        issues = log[-1]["result"]["reviewIssues"]
        low_conf = [
            i for i in issues if i["reason"] == "low_model_confidence"
        ]
        assert low_conf
        # No shift applied — times stay on the absolute timeline.
        assert low_conf[0]["timeRange"]["startSec"] == pytest.approx(2.5)

    def test_selection_outside_audio_fails_cleanly(
        self, tmp_path: Path
    ) -> None:
        log = self._run(
            tmp_path,
            make_events([60]),
            {
                "range": "selection",
                "selectionStartSec": 20.0,
                "selectionEndSec": 30.0,
            },
        )
        assert log[-1]["phase"] == "failed"
        assert log[-1]["error"]["code"] == "NO_PITCHED_CONTENT"

    def test_shift_event_times_moves_bends(self) -> None:
        from hornscribe.transcription.pipeline import _shift_event_times

        ev = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60.0,
            onset_sec=0.5,
            offset_sec=1.0,
            pitch_bends=(
                PitchBendPoint(time_sec=0.6, bend_semitones=0.5),
            ),
        )
        (shifted,) = _shift_event_times((ev,), 2.0)
        assert shifted.onset_sec == pytest.approx(2.5)
        assert shifted.offset_sec == pytest.approx(3.0)
        assert shifted.pitch_bends[0].time_sec == pytest.approx(2.6)
        # Zero offset returns the input untouched.
        assert _shift_event_times((ev,), 0.0) == (ev,)

    def test_whole_piece_issues_span_the_selection_not_the_source(
        self, tmp_path: Path
    ) -> None:
        """#321: whole-piece issues (overlap/meter/…) describe the
        analysed span. A [2, 4] selection of a 10 s source must not
        produce issues pointing at 0..10 — the review A-B loop would
        drag the user outside the range they actually transcribed."""
        # Overlapping slice-relative events collapse to one line under
        # the monophonic textures -> overlapping_candidates fires.
        events = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60.0,
                onset_sec=0.5,
                offset_sec=1.5,
                confidence=0.9,
                velocity=90,
                source="test",
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=67.0,
                onset_sec=1.0,
                offset_sec=1.8,
                confidence=0.9,
                velocity=90,
                source="test",
            ),
        )
        log = self._run(
            tmp_path,
            events,
            {
                "range": "selection",
                "selectionStartSec": 2.0,
                "selectionEndSec": 4.0,
            },
        )
        assert log[-1]["phase"] == "completed"
        issues = log[-1]["result"]["reviewIssues"]
        overlap = [
            i for i in issues if i["reason"] == "overlapping_candidates"
        ]
        assert overlap, "expected a whole-piece overlap issue"
        for issue in overlap:
            assert issue["timeRange"]["startSec"] == pytest.approx(2.0)
            assert issue["timeRange"]["endSec"] == pytest.approx(4.0)
        # Every whole-piece issue (no note ids) honours the analysis
        # span — note-level issues keep their own ranges.
        for issue in issues:
            if not issue["canonicalNoteIds"]:
                assert issue["timeRange"]["startSec"] >= 2.0
                assert issue["timeRange"]["endSec"] <= 4.0


class TestRawEvidence:
    """#223/#226: the completed scoreDocument carries the raw
    transcription evidence inline so projects persist it and
    requantize can replay the real performance."""

    def test_completed_document_carries_raw_evidence(
        self, tmp_path: Path
    ) -> None:
        events = make_events([60, 62, 64])
        log = run(tmp_path, events)
        assert log[-1]["phase"] == "completed"
        doc = log[-1]["result"]["scoreDocument"]
        evidence = doc.get("rawEvidence")
        assert isinstance(evidence, dict)
        assert evidence["transcriptionRevision"].startswith("tr-")
        # One part, events serialized with absolute source seconds.
        parts = evidence["parts"]
        assert len(parts) == 1
        evs = parts[0]["events"]
        assert len(evs) == len(events)
        assert evs[0]["onsetSec"] == pytest.approx(0.0)
        assert evs[0]["pitchMidi"] == pytest.approx(60.0)
        # The warp evidence is present and well-formed.
        assert evidence["warp"]["kind"] in ("fixedBpm", "beatMap")

    def test_evidence_survives_document_round_trip(
        self, tmp_path: Path
    ) -> None:
        from hornscribe.domain.score import ScoreDocument

        log = run(tmp_path, make_events([60, 62]))
        assert log[-1]["phase"] == "completed"
        doc = log[-1]["result"]["scoreDocument"]
        restored = ScoreDocument.from_dict(doc)
        assert restored.raw_evidence is not None
        assert len(restored.raw_evidence["parts"][0]["events"]) == 2


class TestVocalProvenance:
    """#319: the effective isolation chain lands on the tr-* identity
    and the result meta — the same settings over different preprocess
    methods must not share a transcription revision."""

    def _run_isolated(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        method: str | None,
        version: str | None,
        reason: str,
    ) -> dict[str, Any]:
        import hornscribe.transcription.pipeline as pipeline_mod

        if method is not None:
            staged = tmp_path / "vocal.wav"
            staged.write_bytes(b"x")

            monkeypatch.setattr(
                pipeline_mod,
                "vocal_wav",
                lambda *a, **k: (str(staged), "applied", False, method, version),
            )
        else:
            monkeypatch.setattr(
                pipeline_mod,
                "vocal_wav",
                lambda *a, **k: (None, reason, False, None, None),
            )
        log = run(tmp_path, make_events([60, 62, 64]), {"vocalIsolation": True})
        assert log[-1]["phase"] == "completed"
        return log[-1]["result"]

    def test_meta_records_the_effective_chain(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        res = self._run_isolated(
            tmp_path, monkeypatch, "center_extraction", "1", "applied"
        )
        assert res["meta"]["preprocess"] == {
            "vocalIsolation": True,
            "method": "center_extraction",
            "methodVersion": "1",
        }

    def test_method_and_fallback_change_the_revision(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        demucs = self._run_isolated(
            tmp_path, monkeypatch, "demucs", "4.0.1", "applied"
        )
        center = self._run_isolated(
            tmp_path, monkeypatch, "center_extraction", "1", "applied"
        )
        failed = self._run_isolated(
            tmp_path, monkeypatch, None, None, "unavailable"
        )
        revs = {
            r["meta"]["transcriptionRevision"]
            for r in (demucs, center, failed)
        }
        # demucs / center / raw-fallback each minted a distinct tr-*.
        assert len(revs) == 3
        assert failed["meta"]["preprocess"]["method"] == "none"
        assert failed["meta"]["preprocess"]["fallbackReason"] == (
            "unavailable"
        )

    def test_no_isolation_leaves_meta_clean(
        self, tmp_path: Path
    ) -> None:
        res = run(tmp_path, make_events([60]))[-1]["result"]
        assert "preprocess" not in res["meta"]




class TestVocalPolyphonicConflict:
    """#322: voices/chords keep the overlapping lines — vocal
    isolation would strip the accompaniment first, so the engine
    skips it and reports the conflict instead of silently ignoring
    an option the UI also disables."""

    def test_voices_texture_skips_isolation(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import hornscribe.transcription.pipeline as pipeline_mod

        called: list[bool] = []
        monkeypatch.setattr(
            pipeline_mod,
            "vocal_wav",
            lambda *a, **k: called.append(True) or (None, "x", False, None, None),
        )
        log = run(
            tmp_path,
            make_events([60, 62, 64]),
            {"vocalIsolation": True, "texture": "voices"},
        )
        assert log[-1]["phase"] == "completed"
        # Isolation never ran — the backend saw the raw mix.
        assert called == []
        issues = log[-1]["result"]["reviewIssues"]
        unavail = [
            i for i in issues
            if i["reason"] == "vocal_isolation_unavailable"
        ]
        assert unavail and (
            unavail[0]["evidence"]["detail"] == "polyphonic_texture"
        )
        # Provenance records the skipped isolation honestly.
        pre = log[-1]["result"]["meta"]["preprocess"]
        assert pre["method"] == "none"
        assert pre["fallbackReason"] == "polyphonic_texture"

    def test_melody_texture_still_isolates(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import hornscribe.transcription.pipeline as pipeline_mod

        staged = tmp_path / "v.wav"
        staged.write_bytes(b"x")
        monkeypatch.setattr(
            pipeline_mod,
            "vocal_wav",
            lambda *a, **k: (str(staged), "applied", False, "center_extraction", "1"),
        )
        log = run(
            tmp_path,
            make_events([60, 62, 64]),
            {"vocalIsolation": True, "texture": "melody"},
        )
        assert log[-1]["phase"] == "completed"
        issues = log[-1]["result"]["reviewIssues"]
        assert any(
            i["reason"] == "vocal_isolation_applied" for i in issues
        )


