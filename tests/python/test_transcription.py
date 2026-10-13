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
from hornscribe.transcription.clean import (
    CleanedEvents,
    clean_monophonic,
    clip_to_range,
)
from hornscribe.transcription.key import (
    analyze_key,
    estimate_key,
    estimate_key_segments,
    key_uncertainty,
)
from hornscribe.transcription.meter import estimate_meter
from hornscribe.transcription.options import TranscriptionParams
from hornscribe.transcription.pipeline import (
    STAGES,
    _accomp_band_evidence,
    _accomp_band_verdict,
    _accomp_confidence_floor,
    _accomp_detected_events,
    _accomp_pad_completion,
    _accomp_train_completion,
    _admit_stem_lattice_candidates,
    _backdate_accomp_onsets,
    _dedup_accomp_unison,
    _drop_stem_bleed_lows,
    _fold_accomp_slivers,
    _heal_accomp_fragments,
    _merge_band_fragments,
    _pad_event_voices,
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

    def test_max_voices_parsed_validated_and_echoed(self) -> None:
        # #355: the voice cap travels with the job and lands in the
        # settings echo like every other option.
        p = TranscriptionParams.from_payload(
            {"audioPath": "a", "maxVoices": 4}
        )
        assert p.max_voices == 4
        assert p.settings_dict()["maxVoices"] == 4
        assert (
            TranscriptionParams.from_payload({"audioPath": "a"}).max_voices
            == 3
        )
        for bad in (1, 9, 4.5, "four", True):
            with pytest.raises(ValueError, match="maxVoices"):
                TranscriptionParams.from_payload(
                    {"audioPath": "a", "maxVoices": bad}
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

    def test_octave_verdict_blocks_snap(self) -> None:
        # octave-leaps-4-4: a played C4->C5->C4 figure trips the
        # neighbour pitch-class rule, but the note's own spectrum
        # says the high octave is real — the verdict vetoes the snap.
        evs = make_events([60, 72, 60], beat_sec=0.5)
        out = clean_monophonic(evs, octave_verdict=lambda ev, tgt: False)
        assert out.octave_corrected == 0
        assert [int(e.pitch_midi) for e in out.events] == [60, 72, 60]

    def test_octave_verdict_confirms_snap(self) -> None:
        # Same figure, spectrum favours the target octave — the snap
        # still fires, and the verdict sees the proposed target.
        evs = make_events([60, 72, 60], beat_sec=0.5)
        seen: list[tuple[float, float]] = []

        def _verdict(ev: RawNoteEvent, target: float) -> bool:
            seen.append((ev.pitch_midi, target))
            return True

        out = clean_monophonic(evs, octave_verdict=_verdict)
        assert out.octave_corrected == 1
        assert [int(e.pitch_midi) for e in out.events] == [60, 60, 60]
        assert seen == [(72.0, 60.0)]

    def test_octave_excursion_snapped_by_spectrum(self) -> None:
        # E4 C4 D2 A3 D4 — the D2's neighbours share no pitch class,
        # so the flicker rule never sees it; the excursion pass asks
        # the spectrum instead, and the +24 fundamental dominates.
        evs = make_events([64, 60, 38, 57, 62], beat_sec=0.5)
        out = clean_monophonic(
            evs, octave_verdict=lambda ev, tgt: tgt >= 60
        )
        assert out.octave_corrected == 1
        assert int(out.events[2].pitch_midi) == 62

    def test_octave_excursion_verdict_vetoes(self) -> None:
        # Same shape, but the note's own spectrum keeps the detected
        # octave — a real register jump is never moved on the
        # context prior alone.
        evs = make_events([64, 60, 38, 57, 62], beat_sec=0.5)
        out = clean_monophonic(evs, octave_verdict=lambda ev, tgt: False)
        assert out.octave_corrected == 0
        assert int(out.events[2].pitch_midi) == 38

    def test_octave_excursion_skipped_without_verdict(self) -> None:
        # No audio access -> no spectrum arbitration -> the pass is
        # inert and the deviant note stays as detected.
        evs = make_events([64, 60, 38, 57, 62], beat_sec=0.5)
        out = clean_monophonic(evs)
        assert out.octave_corrected == 0
        assert int(out.events[2].pitch_midi) == 38

    def test_octave_excursion_thin_context_skipped(self) -> None:
        # Notes spaced beyond the context window leave no median to
        # judge against — the verdict is never consulted.
        evs = make_events([38, 64, 60, 57], beat_sec=3.0, dur_ratio=0.3)
        seen: list[float] = []

        def _verdict(ev: RawNoteEvent, target: float) -> bool:
            seen.append(target)
            return True

        out = clean_monophonic(evs, octave_verdict=_verdict)
        assert seen == []
        assert out.octave_corrected == 0

    def test_octave_excursion_subspan_snap(self) -> None:
        # #254: a sub-120 ms note a full octave+ below its context is
        # tracker flicker — the FFT cannot arbitrate a span that
        # short, so the pass snaps one octave toward the median
        # without consulting (or needing) the verdict.
        base = list(
            make_events([64, 60, 62, 57, 64, 60], beat_sec=0.5, dur_ratio=0.4)
        )
        blip = RawNoteEvent(
            id=RawNoteEventId("rne-000099"),
            transcription_revision=_REV,
            pitch_midi=47.0,  # B2 dropped into an octave-4 passage
            onset_sec=1.3,    # inside the gap between neighbours
            offset_sec=1.4,   # 100 ms — below the spectral limit
            confidence=0.4,
        )
        out = clean_monophonic(
            tuple(base[:3]) + (blip,) + tuple(base[3:]),
            octave_verdict=lambda ev, tgt: False,
        )
        pitches = [int(e.pitch_midi) for e in out.events]
        assert 59 in pitches  # B2 snapped to B3
        assert 47 not in pitches
        assert out.octave_corrected == 1

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

    def test_melody_prefer_repairs_fragmented_sustain(self) -> None:
        # jpop-mix lesson: on a multi-layer source the backend splits a
        # sustained lead note on strong grid positions (drum/pad
        # transients) and interleaves lower accompaniment hypotheses
        # between the fragments. The adjacent-only merge never saw
        # them, so every split survived as an extra note. prefer="top"
        # now merges a fragment back into the last kept event of the
        # same pitch when only lower events interleave.
        frag_a = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=0.5,
            confidence=0.9,
        )
        bass = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=43,
            onset_sec=0.25,
            offset_sec=0.4,
            confidence=0.8,
        )
        frag_b = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.51,
            offset_sec=0.9,
            confidence=0.8,
        )
        out = clean_monophonic((frag_a, bass, frag_b), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].offset_sec == pytest.approx(0.9)
        assert out.merged == 1

    def test_melody_prefer_no_merge_across_higher_interleave(self) -> None:
        # A higher event between the fragments is real melodic movement
        # — bridging it would swallow the second attack.
        frag_a = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=0.5,
            confidence=0.9,
        )
        higher = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=81,
            onset_sec=0.2,
            offset_sec=0.4,
            confidence=0.9,
        )
        frag_b = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.51,
            offset_sec=0.9,
            confidence=0.9,
        )
        out = clean_monophonic((frag_a, higher, frag_b), prefer="top")
        # 76a clips at the 81 onset; 76b stays its own note after the
        # higher note ends.
        assert len(out.events) == 3
        assert out.events[0].offset_sec == pytest.approx(0.2)
        assert int(out.events[1].pitch_midi) == 81
        assert int(out.events[2].pitch_midi) == 76
        assert out.merged == 0

    def test_melody_prefer_no_merge_beyond_gap(self) -> None:
        # A real gap (> merge_gap_sec) between the fragments means the
        # second onset is a re-articulation, not a split — kept apart.
        frag_a = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=0.5,
            confidence=0.9,
        )
        bass = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=43,
            onset_sec=0.3,
            offset_sec=0.45,
            confidence=0.8,
        )
        frag_b = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.6,
            offset_sec=0.9,
            confidence=0.8,
        )
        out = clean_monophonic((frag_a, bass, frag_b), prefer="top")
        assert len(out.events) == 2
        assert out.merged == 0

    def test_onset_prefer_keeps_fragment_behaviour(self) -> None:
        # prefer="onset" (mono solos): a confident interleaved lower
        # note stays real content — only weak FULLY-CONTAINED lowers are
        # artifacts (#129), and this bass extends the sustain while
        # carrying comparable confidence, so bridging it would hide a
        # true re-articulation.
        frag_a = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=0.5,
            confidence=0.9,
        )
        bass = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=43,
            onset_sec=0.25,
            offset_sec=0.4,
            confidence=0.8,
        )
        frag_b = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.51,
            offset_sec=0.9,
            confidence=0.8,
        )
        out = clean_monophonic((frag_a, bass, frag_b), prefer="onset")
        assert len(out.events) == 3
        assert out.merged == 0

    def test_prefer_rejects_unknown_value(self) -> None:
        with pytest.raises(ValueError, match="prefer"):
            clean_monophonic(make_events([60]), prefer="loud")

    # ---- #129: contained-lower ghosts under the mono contract ----

    def test_onset_contained_lower_ghost_dropped(self) -> None:
        # A weak, lower note entirely inside a sustained note's span
        # is a rumble/subharmonic artifact: drop it and keep the
        # sustain's full tail instead of clipping at its onset.
        sustain = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=2.0,
            confidence=0.81,
        )
        rumble = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=41,  # ~85 Hz handling rumble, not harmonic
            onset_sec=0.8,
            offset_sec=1.2,
            confidence=0.43,
        )
        nxt = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=70,
            onset_sec=2.1,
            offset_sec=2.6,
            confidence=0.8,
        )
        out = clean_monophonic((sustain, rumble, nxt))
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(2.0)
        assert out.events[1].pitch_midi == pytest.approx(70)
        assert out.ghost_dropped == 1
        assert out.clipped_overlaps == 0

    def test_onset_contained_lower_strong_interleave_kept(self) -> None:
        # The conf margin protects a genuinely loud interleave: a bass
        # note at near-equal confidence is real content (or evidence
        # the source is not mono) — clip, don't delete (#129 caution).
        sustain = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=2.0,
            confidence=0.81,
        )
        bass = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=41,
            onset_sec=0.8,
            offset_sec=1.2,
            confidence=0.75,
        )
        out = clean_monophonic((sustain, bass))
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(0.8)
        assert out.clipped_overlaps == 1
        assert out.polyphonic_overlaps == 1
        assert out.ghost_dropped == 0

    def test_onset_lower_overlap_past_end_is_real(self) -> None:
        # A lower note that continues PAST the sustain's end is real
        # melodic motion even when weak — containment (tail inside)
        # is what marks the artifact.
        sustain = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=1.0,
            confidence=0.9,
        )
        lower = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.5,
            offset_sec=1.4,
            confidence=0.3,
        )
        out = clean_monophonic((sustain, lower))
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(0.5)
        assert out.events[1].pitch_midi == pytest.approx(60)
        assert out.clipped_overlaps == 1
        assert out.ghost_dropped == 0

    def test_onset_contained_higher_kept(self) -> None:
        # Contained notes ABOVE the sustain are not the rumble
        # signature — a non-harmonic higher interleave still clips.
        sustain = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=2.0,
            confidence=0.9,
        )
        higher = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=74,  # 14 semitones — not a ghost interval
            onset_sec=0.8,
            offset_sec=1.2,
            confidence=0.5,
        )
        out = clean_monophonic((sustain, higher))
        assert len(out.events) == 2
        assert out.events[0].offset_sec == pytest.approx(0.8)
        assert out.clipped_overlaps == 1
        assert out.ghost_dropped == 0

    def test_onset_multiple_contained_ghosts_dropped(self) -> None:
        # The observed BP signature emits several weak low hypotheses
        # inside one sustain — every contained one is suppressed.
        sustain = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=2.2,
            confidence=0.81,
        )
        g1 = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=41,
            onset_sec=0.8,
            offset_sec=1.2,
            confidence=0.43,
        )
        g2 = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=57,
            onset_sec=1.9,
            offset_sec=2.05,
            confidence=0.37,
        )
        out = clean_monophonic((sustain, g1, g2))
        assert len(out.events) == 1
        assert out.events[0].offset_sec == pytest.approx(2.2)
        assert out.ghost_dropped == 2

    def test_edge_evidence_keeps_same_pitch_rearticulation(self) -> None:
        # boundary-4-4: the seam gate vetoes a same-pitch merge when
        # the audio carries a real attack on the seam — a tongued
        # repeat must not collapse into one held note.
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=3.5,
                offset_sec=3.97,
                confidence=0.8,
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=4.0,
                offset_sec=4.5,
                confidence=0.8,
            ),
        )
        out = clean_monophonic(evs, edge_evidence=lambda a, b: True)
        assert len(out.events) == 2
        assert out.merged == 0

    def test_edge_evidence_absent_or_false_merges(self) -> None:
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.0,
                offset_sec=0.48,
                confidence=0.8,
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=60,
                onset_sec=0.48,
                offset_sec=0.9,
                confidence=0.8,
            ),
        )
        assert len(clean_monophonic(evs).events) == 1
        gated = clean_monophonic(evs, edge_evidence=lambda a, b: False)
        assert len(gated.events) == 1
        assert gated.merged == 1

    def test_edge_evidence_only_consulted_under_onset(self) -> None:
        # prefer="top" merges unconditionally — on a mix the flux at a
        # same-pitch seam is usually an accompaniment transient, which
        # is exactly what the bridge merge exists to heal.
        evs = (
            RawNoteEvent(
                id=RawNoteEventId("rne-000001"),
                transcription_revision=_REV,
                pitch_midi=76,
                onset_sec=0.0,
                offset_sec=0.48,
                confidence=0.8,
            ),
            RawNoteEvent(
                id=RawNoteEventId("rne-000002"),
                transcription_revision=_REV,
                pitch_midi=76,
                onset_sec=0.48,
                offset_sec=0.9,
                confidence=0.8,
            ),
        )
        out = clean_monophonic(
            evs, prefer="top", edge_evidence=lambda a, b: True
        )
        assert len(out.events) == 1
        assert out.merged == 1

    def test_edge_evidence_abstains_when_seam_busy(self) -> None:
        # reverb-4-4 shape: a third event attacks inside the seam's
        # flux window — the onset peak is its energy, not evidence the
        # same-pitch pair re-articulated. The gate abstains (merge).
        a = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=0.5,
            confidence=0.8,
        )
        b = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.5,
            offset_sec=1.0,
            confidence=0.7,
        )
        intruder = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=64,
            onset_sec=0.54,  # attacks inside b's seam window
            offset_sec=1.4,
            confidence=0.9,
        )
        gated = clean_monophonic(
            (a, b, intruder), edge_evidence=lambda x, y: True
        )
        assert gated.merged == 1
        # a+b merged, then clipped at the intruder's onset.
        assert gated.events[0].offset_sec == pytest.approx(0.54)
        # Without the intruder the same pair stays split.
        free = clean_monophonic((a, b), edge_evidence=lambda x, y: True)
        assert free.merged == 0
        assert len(free.events) == 2

    def test_tail_retrigger_contained_frag_suppressed(self) -> None:
        # reverb-4-4: a short contained event at the predecessor's
        # pitch is the just-ended note's ringing tail re-firing under
        # the new attack — suppress it instead of clipping the real
        # note down to a too-short stub.
        before = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=1.0,
            confidence=0.8,
        )
        prev = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=67,
            onset_sec=0.98,
            offset_sec=2.0,
            confidence=0.7,
        )
        frag = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=1.02,
            offset_sec=1.15,
            confidence=0.55,
        )
        out = clean_monophonic((before, prev, frag))
        assert [e.pitch_midi for e in out.events] == [60.0, 67.0]
        # The real note keeps its full span — no stub, no phantom 60.
        assert out.events[1].offset_sec == pytest.approx(2.0)
        assert out.ghost_dropped == 1

    def test_tail_retrigger_requires_predecessor_pitch_match(self) -> None:
        # Same contained shape at a DIFFERENT pitch is not a tail
        # re-trigger — the ordinary confidence test still decides, and
        # here the interleave is too strong to call a ghost (#129).
        before = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=60,
            onset_sec=0.0,
            offset_sec=1.0,
            confidence=0.8,
        )
        prev = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=67,
            onset_sec=0.98,
            offset_sec=2.0,
            confidence=0.7,
        )
        frag = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=62,  # not before's pitch
            onset_sec=1.02,
            offset_sec=1.15,
            confidence=0.55,
        )
        out = clean_monophonic((before, prev, frag))
        assert len(out.events) == 3
        assert out.ghost_dropped == 0

    def test_preattack_octave_stub_folds_into_successor(self) -> None:
        # quiet-lead-mix: on a masked attack the backend opens on the
        # sub-octave for ~46 ms before settling — the stub scored as an
        # extra note and pushed the real onset late.  It folds into the
        # successor, keeping the stub's earlier onset as the attack.
        stub = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.952,
            offset_sec=0.998,
            confidence=0.55,
        )
        real = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=81,
            onset_sec=0.998,
            offset_sec=1.161,
            confidence=0.58,
        )
        out = clean_monophonic((stub, real), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].pitch_midi == 81
        assert out.events[0].onset_sec == pytest.approx(0.952)
        assert out.events[0].offset_sec == pytest.approx(1.161)
        assert out.preattack_folded == 1

    def test_preattack_stub_fold_needs_octave_and_stub_length(
        self,
    ) -> None:
        # Longer than the sub-32nd cap is a played figure, and a
        # non-octave step is melodic motion — neither folds.
        low = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=0.15,
            confidence=0.55,
        )
        high = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=81,
            onset_sec=0.15,
            offset_sec=0.6,
            confidence=0.58,
        )
        out = clean_monophonic((low, high), prefer="top")
        assert len(out.events) == 2
        assert out.preattack_folded == 0

        step = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=67,
            onset_sec=0.0,
            offset_sec=0.05,
            confidence=0.55,
        )
        near = RawNoteEvent(
            id=RawNoteEventId("rne-000004"),
            transcription_revision=_REV,
            pitch_midi=72,
            onset_sec=0.05,
            offset_sec=0.6,
            confidence=0.58,
        )
        out = clean_monophonic((step, near), prefer="top")
        assert len(out.events) == 2
        assert out.preattack_folded == 0

    def test_preattack_stub_fold_is_melody_only(self) -> None:
        # prefer="onset" keeps the honest event stream — the fold is a
        # melody-extraction policy, not a mono contract rule.
        stub = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=0.046,
            confidence=0.55,
        )
        real = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=81,
            onset_sec=0.046,
            offset_sec=0.3,
            confidence=0.58,
        )
        out = clean_monophonic((stub, real))
        assert len(out.events) == 2
        assert out.preattack_folded == 0

    def test_lower_line_needs_real_overhang(self) -> None:
        # quiet-lead-mix shape: a bleed attacked WITH the top and
        # "outlived" it by 12 ms — the bare > test read frame jitter as
        # a line running on underneath and stole the slot.
        top = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=2.114,
            offset_sec=2.300,
            confidence=0.32,
        )
        bleed = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=2.114,
            offset_sec=2.312,
            confidence=0.42,
        )
        out = clean_monophonic((top, bleed), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].pitch_midi == 76

    def test_lower_line_resume_at_overlay_boundary(self) -> None:
        # jpop-mix-hard: a merged overlay's tail overshoots the true
        # release — a same-pitch re-attack landing just past the
        # nominal end is the buried line continuing, not ordinary
        # succession, so the real attack displaces the overlay.
        blob = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=12.198,
            offset_sec=12.872,
            confidence=0.79,
        )
        attack = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=72,
            onset_sec=12.663,
            offset_sec=12.895,
            confidence=0.83,
        )
        resume = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=72,
            onset_sec=12.895,
            offset_sec=13.057,
            confidence=0.85,
        )
        out = clean_monophonic((blob, attack, resume), prefer="top")
        assert [e.pitch_midi for e in out.events] == [76.0, 72.0]
        assert out.events[0].offset_sec == pytest.approx(12.663)
        assert out.events[1].onset_sec == pytest.approx(12.663)

    def test_vibrato_veto_protects_singing_incumbent(self) -> None:
        # The incumbent modulates inside the contested window while the
        # challenger is a steady tone — the lower cannot displace a
        # singing line on confidence alone.
        bend = PitchBendPoint
        top = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=1.0,
            confidence=0.32,
            pitch_bends=tuple(
                bend(0.05 + k * 0.08, 0.7 if k % 2 else 0.0)
                for k in range(10)
            ),
        )
        bleed = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.0,
            offset_sec=1.3,
            confidence=0.6,
            pitch_bends=tuple(
                bend(0.05 + k * 0.08, 0.33) for k in range(10)
            ),
        )
        out = clean_monophonic((top, bleed), prefer="top")
        assert len(out.events) == 1
        assert out.events[0].pitch_midi == 76

    def test_vibrato_veto_ignores_span_outside_the_overlap(
        self,
    ) -> None:
        # jpop-mix-hard: a merged incumbent's union bend series pools
        # fragments whose pitch-centre offsets disagree — a fake 0.67
        # span.  The veto measures only the contested window, so the
        # stronger real attack still displaces the overlay.
        bend = PitchBendPoint
        top = RawNoteEvent(
            id=RawNoteEventId("rne-000001"),
            transcription_revision=_REV,
            pitch_midi=76,
            onset_sec=0.0,
            offset_sec=1.0,
            confidence=0.79,
            pitch_bends=(
                tuple(
                    bend(0.02 + k * 0.04, 0.7 if k % 2 else 0.0)
                    for k in range(5)
                )
                + tuple(
                    bend(0.4 + k * 0.08, 0.33) for k in range(7)
                )
            ),
        )
        attack = RawNoteEvent(
            id=RawNoteEventId("rne-000002"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=0.3,
            offset_sec=1.0,
            confidence=0.85,
        )
        resume = RawNoteEvent(
            id=RawNoteEventId("rne-000003"),
            transcription_revision=_REV,
            pitch_midi=69,
            onset_sec=1.0,
            offset_sec=1.15,
            confidence=0.85,
        )
        out = clean_monophonic((top, attack, resume), prefer="top")
        assert [e.pitch_midi for e in out.events] == [76.0, 69.0]
        assert out.events[0].offset_sec == pytest.approx(0.3)


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

    def test_concurrent_octave_ghosts_are_dropped(self) -> None:
        # #92: the octave error attacks WITH the fundamental and rings
        # just as long -- neither the short-span nor the late-attack
        # tells apply, only the confidence deficit does.
        from hornscribe.transcription.clean import split_voices

        low = self._ev(1, 48, 0.03, 0.44, confidence=0.65)
        high = self._ev(2, 52, 0.01, 0.44, confidence=0.67)
        ghost_low = self._ev(3, 60, 0.02, 0.40, confidence=0.42)  # +12 low
        ghost_high = self._ev(4, 64, 0.02, 0.35, confidence=0.33)  # +12 high
        out = split_voices((low, high, ghost_low, ghost_high))
        assert out.ghost_dropped == 2
        assert sum(len(v) for v in out.voices) == 2

    def test_concurrent_rule_keeps_a_real_quiet_octave(self) -> None:
        # A genuine octave doubling may be quieter -- the ratio guard
        # spares it (0.5 is not below 0.65 * 0.7).
        from hornscribe.transcription.clean import split_voices

        fundamental = self._ev(1, 60, 0.0, 0.5, confidence=0.65)
        doubled = self._ev(2, 72, 0.01, 0.5, confidence=0.5)
        out = split_voices((fundamental, doubled))
        assert out.ghost_dropped == 0
        assert sum(len(v) for v in out.voices) == 2

    def test_concurrent_rule_needs_the_absolute_gap(self) -> None:
        # Below-confidence events: the 0.15 absolute deficit guard is
        # what keeps a soft doubling alive when only the ratio fires.
        from hornscribe.transcription.clean import split_voices

        fundamental = self._ev(1, 48, 0.0, 0.5, confidence=0.4)
        doubled = self._ev(2, 60, 0.01, 0.5, confidence=0.27)
        out = split_voices((fundamental, doubled))
        assert out.ghost_dropped == 0
        assert sum(len(v) for v in out.voices) == 2

    def test_concurrent_ghost_does_not_clip_the_real_tail(self) -> None:
        # clean_monophonic gets the same suppression -- a ghost that
        # sorts after the real note used to clip its tail and survive.
        from hornscribe.transcription.clean import clean_monophonic

        real = self._ev(1, 48, 0.0, 0.5, confidence=0.65)
        ghost = self._ev(2, 60, 0.02, 0.4, confidence=0.4)  # +12 at onset
        out = clean_monophonic((real, ghost))
        assert out.ghost_dropped == 1
        assert [e.pitch_midi for e in out.events] == [48.0]
        assert out.events[0].offset_sec == pytest.approx(0.5)

    def test_fragment_boundary_cannot_anchor_a_concurrent_ghost(self) -> None:
        # #183 (pad8th m60@11.024): the bass detector split one held
        # tone at 11.036 and the fragment's boundary counted as an
        # attack — eating the real pad re-strike a twelfth above it.
        # With the attack guard the killer is a continuation, so the
        # pair is not concurrent and the chord tone survives.
        from hornscribe.transcription.clean import split_voices

        bass_head = self._ev(1, 41, 0.780, 1.036, confidence=0.625)
        bass_frag = self._ev(2, 41, 1.036, 1.210, confidence=0.586)
        chord = self._ev(3, 60, 1.024, 1.326, confidence=0.357)  # +19
        out = split_voices(
            (bass_head, bass_frag, chord),
            max_voices=4,
            ghost_attack_slack_sec=0.03,
        )
        assert out.ghost_dropped == 0
        assert any(
            e.pitch_midi == 60.0 for v in out.voices for e in v
        )

        # Without the guard the same trio still loses the chord tone.
        out = split_voices((bass_head, bass_frag, chord), max_voices=4)
        assert out.ghost_dropped == 1

    def test_real_attack_killer_still_suppresses_the_ghost(self) -> None:
        # #183 safety: a fundamental that really did attack at the
        # shared onset keeps its suppression — the guard only spares
        # candidates paired against continuation fragments.
        from hornscribe.transcription.clean import split_voices

        bass = self._ev(1, 41, 1.036, 1.210, confidence=0.586)
        ghost = self._ev(2, 60, 1.024, 1.326, confidence=0.357)  # +19
        out = split_voices(
            (bass, ghost), max_voices=4, ghost_attack_slack_sec=0.03
        )
        assert out.ghost_dropped == 1

    def test_attack_guard_respects_the_slack(self) -> None:
        # A same-pitch note that ended well before the onset is a real
        # re-attack, not a continuation — the pair stays concurrent.
        from hornscribe.transcription.clean import split_voices

        bass_head = self._ev(1, 41, 0.780, 0.990, confidence=0.625)
        bass_frag = self._ev(2, 41, 1.036, 1.210, confidence=0.586)
        chord = self._ev(3, 60, 1.024, 1.326, confidence=0.357)  # +19
        out = split_voices(
            (bass_head, bass_frag, chord),
            max_voices=4,
            ghost_attack_slack_sec=0.03,
        )
        assert out.ghost_dropped == 1

    def test_top_fragment_over_long_pad_is_not_a_ghost(self) -> None:
        # #130: under melody texture the stronger concurrent note at a
        # harmonic interval is usually accompaniment, not a
        # fundamental. A real ghost rides the whole span -- a melody
        # fragment ringing only part of a sustained pad must survive.
        from hornscribe.transcription.clean import clean_monophonic

        pad = self._ev(1, 57, 0.0, 1.0, confidence=0.55)
        melody = self._ev(2, 76, 0.02, 0.2, confidence=0.38)  # +19
        out = clean_monophonic((pad, melody), prefer="top")
        assert out.ghost_dropped == 0
        assert [e.pitch_midi for e in out.events] == [76.0]

        # prefer="onset" keeps the strict signature -- same input is a
        # concurrent ghost there.
        out = clean_monophonic((pad, melody))
        assert out.ghost_dropped == 1
        assert [e.pitch_midi for e in out.events] == [57.0]

    def test_top_still_drops_a_full_span_concurrent_ghost(self) -> None:
        # The coverage requirement must not reopen #92: a weak octave
        # error that really does ring with the fundamental still dies.
        from hornscribe.transcription.clean import clean_monophonic

        real = self._ev(1, 48, 0.0, 0.5, confidence=0.65)
        ghost = self._ev(2, 60, 0.02, 0.48, confidence=0.4)
        out = clean_monophonic((real, ghost), prefer="top")
        assert out.ghost_dropped == 1
        assert [e.pitch_midi for e in out.events] == [48.0]

    def test_top_higher_note_with_marginal_deficit_is_movement(self) -> None:
        # #130: a higher note cutting in IS the melody contract —
        # "overtone of the lower note" needs a real confidence deficit,
        # not a hairline one (a 0.40 melody fragment was being eaten by
        # a 0.42 strum a fifth below).
        from hornscribe.transcription.clean import clean_monophonic

        strum = self._ev(1, 69, 0.0, 0.4, confidence=0.42)
        melody = self._ev(2, 76, 0.1, 0.19, confidence=0.40)  # +7, short
        out = clean_monophonic((strum, melody), prefer="top")
        assert out.ghost_dropped == 0
        pitches = [e.pitch_midi for e in out.events]
        assert pitches == [69.0, 76.0]
        assert out.events[0].offset_sec == pytest.approx(0.1)

        # Onset mode is unchanged: the same pair is still a ghost.
        out = clean_monophonic((strum, melody))
        assert out.ghost_dropped == 1
        assert [e.pitch_midi for e in out.events] == [69.0]

    def test_top_higher_note_with_real_deficit_still_dies(self) -> None:
        # A genuine upward flicker ghost keeps losing: the deficit
        # requirement only spares near-equal-confidence movement.
        from hornscribe.transcription.clean import clean_monophonic

        real = self._ev(1, 69, 0.0, 0.4, confidence=0.75)
        ghost = self._ev(2, 76, 0.1, 0.19, confidence=0.40)
        out = clean_monophonic((real, ghost), prefer="top")
        assert out.ghost_dropped == 1
        assert [e.pitch_midi for e in out.events] == [69.0]

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


class TestMeterEventAccents:
    """#87: the production meter path scores post-onset RMS accents on
    a regularised slot grid -- onset-detector lag, merged subdivisions,
    and short windows must not flip the reading."""

    def _beats(self, n: int, period: float = 0.5) -> tuple[float, ...]:
        return tuple(i * period for i in range(n))

    def test_beat_level_three_four(self) -> None:
        n = 24
        beats = self._beats(n)
        accents = tuple(
            (t, 0.9 if i % 3 == 0 else 0.4) for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter == "3/4"
        assert not est.uncertain
        assert est.tracked_unit_ql is None

    def test_beat_level_six_eight_ternary(self) -> None:
        # Dotted-quarter pulse: slot accents alternate strong/mid and
        # interior events sit on the ternary positions.
        n = 12
        beat = 0.42
        beats = self._beats(n, period=beat)
        accents: list[tuple[float, float]] = []
        for i, t in enumerate(beats):
            accents.append((t, 0.55 if i % 2 == 0 else 0.34))
            accents.append((t + beat / 3, 0.2))
            accents.append((t + 2 * beat / 3, 0.2))
        est = estimate_meter(beats, (), event_accents=tuple(accents))
        assert est.meter == "6/8"
        assert not est.uncertain
        assert est.tracked_unit_ql is None

    def test_beat_level_binary_stays_simple(self) -> None:
        # Same two-level accents but binary eighth subdivisions --
        # the census must keep this a simple meter (2/4), not 6/8.
        n = 16
        beat = 0.42
        beats = self._beats(n, period=beat)
        accents: list[tuple[float, float]] = []
        for i, t in enumerate(beats):
            accents.append((t, 0.6 if i % 2 == 0 else 0.35))
            accents.append((t + beat / 2, 0.2))
        est = estimate_meter(beats, (), event_accents=tuple(accents))
        assert est.meter == "2/4"

    def test_detector_lag_does_not_shift_the_census(self) -> None:
        # A systematic ~45 ms onset lag relative to the tracker used to
        # smear triplet eighths onto the binary midpoint (9/8 and 2/4
        # misreads). The grid recentres on the onsets' own cluster.
        n = 12
        beat = 0.42
        lag = -0.045
        beats = self._beats(n, period=beat)
        accents: list[tuple[float, float]] = []
        for i, t in enumerate(beats):
            accents.append((t + lag, 0.55 if i % 2 == 0 else 0.34))
            accents.append((t + lag + beat / 3, 0.2))
            accents.append((t + lag + 2 * beat / 3, 0.2))
        est = estimate_meter(beats, (), event_accents=tuple(accents))
        assert est.meter == "6/8"
        assert not est.uncertain

    def test_eighth_level_six_eight_anchors_eighths(self) -> None:
        # 240 bpm pulse = tracked eighths: lag accents decide, and the
        # warp anchor must be the eighth, not the compound beat.
        n = 36
        beats = self._beats(n, period=0.25)
        accents = tuple(
            (t, 0.9 if i % 6 == 0 else (0.45 if i % 3 == 0 else 0.3))
            for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter == "6/8"
        assert est.tracked_eighths
        assert est.tracked_unit_ql == Fraction(1, 2)

    def test_short_window_needs_three_periods(self) -> None:
        # 10 slots cannot hold three 5/4 measures -- the period-5
        # read must not compete on two cycles of noise.
        n = 10
        beats = self._beats(n)
        accents = tuple(
            (t, 0.9 if i % 5 == 0 else 0.4) for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter != "5/4"

    def test_dropped_beat_gap_does_not_overflow_slots(self) -> None:
        # Regression (#128): a single dropped tracker beat leaves a
        # 2x interval gap; the lattice span (last-first)/median then
        # exceeds len(beats)-1, and sizing the uniform slot array to
        # the beat count let an onset on the far slot IndexError the
        # whole job (bench tempo-step-4-4 crash). A lone gap does not
        # trip _tempo_shifted, so this exercises the uniform path.
        beats = (0.0, 0.5, 1.0, 1.5, 2.5, 3.0, 3.5, 4.0)
        accents = tuple(
            (t, 0.6 if i % 2 == 0 else 0.3)
            for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter  # any verdict — the contract is "no crash"

    def test_short_tempo_step_keeps_simple_meter(self) -> None:
        # Regression (#199): a 16-beat track has only 15 intervals —
        # under the old 'at least two 8-interval windows' gate the
        # step could never fire variable mode, so the uniform lattice
        # scattered the bar accents into a phantom 5/4. The window
        # must slide over whatever intervals exist.
        beats: list[float] = [0.0]
        for d in [0.6] * 8 + [60.0 / 140.0] * 7:
            beats.append(beats[-1] + d)
        accents = tuple(
            (t, 0.9 if i % 4 == 0 else 0.4) for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter == "4/4"

    def test_continuous_drift_keeps_simple_meter(self) -> None:
        # Regression (#199): a smooth ritard keeps every sliding
        # window near the global median — the first/last thirds
        # comparison is what sees the drift. Index-space slots then
        # keep the accent period readable (rubato-4-4).
        beats = [0.0]
        for k in range(31):
            beats.append(
                beats[-1] + 60.0 / (120.0 + (90.0 - 120.0) * k / 30)
            )
        accents = tuple(
            (t, 0.9 if i % 4 == 0 else 0.4) for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter == "4/4"

    def test_tail_gap_does_not_fake_a_drift(self) -> None:
        # A lone doubled interval at the track's end is tracker
        # fallout, not a rit. — the thirds test must stay quiet so
        # the uniform lattice still regularises the accents.
        beats = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0)
        accents = tuple(
            (t, 0.7 if i % 4 == 0 else 0.3) for i, t in enumerate(beats)
        )
        est = estimate_meter(beats, (), event_accents=accents)
        assert est.meter == "4/4"

    def test_single_ternary_stray_keeps_simple_meter(self) -> None:
        # Regression (#162): one interior hit at a ternary phase used
        # to saturate the subdivision census (ternary_ratio=1.0 ->
        # factor 1.30) and flip a straight four-on-the-floor accent
        # lattice to a TRUSTED 12/8 — measured on the jpop-mix
        # accompaniment channel (ratio4=1.57, one stray at frac 2/3).
        n = 32
        beat = 0.468
        beats = self._beats(n, period=beat)
        accents = [
            (t, 0.12 if i % 4 == 3 else 0.06) for i, t in enumerate(beats)
        ]
        accents.append((beats[11] + beat * 2 / 3, 0.05))
        est = estimate_meter(beats, (), event_accents=tuple(accents))
        assert est.meter == "4/4"
        assert not est.uncertain


class TestMeterChannelFusion:
    """#147: independent accent pools are scored independently and
    fused — a flat channel must not dilute a structured one the way
    the old slot-max merge did (a J-pop mix's four-on-the-floor stem
    envelope flattened every period ratio to ~1.0 and forced a
    refusal on straight 4/4)."""

    def _beats(self, n: int, period: float = 0.5) -> tuple[float, ...]:
        return tuple(i * period for i in range(n))

    @staticmethod
    def _accents(
        beats: tuple[float, ...], period: int, hi: float, lo: float
    ) -> tuple[tuple[float, float], ...]:
        return tuple(
            (t, hi if i % period == 0 else lo)
            for i, t in enumerate(beats)
        )

    def test_accomp_channel_rescues_flat_lead(self) -> None:
        # The reference J-pop mix: the merged pool refused outright,
        # while the accompaniment part's own onsets carry ratio4
        # ~1.6 -- a trusted 4/4.
        beats = self._beats(32)
        flat_lead = tuple((t, 0.25) for t in beats)
        accomp = self._accents(beats, 4, 0.9, 0.4)
        est = estimate_meter(
            beats,
            (),
            event_accents=flat_lead,
            channel_accents={"accompaniment": accomp},
        )
        assert est.meter == "4/4"
        assert not est.uncertain
        assert not est.refused

    def test_trusted_channels_disagree_names_both(self) -> None:
        # A lead reading 3/4 against an accompaniment reading 4/4 is
        # a genuine dispute: the fused verdict stays uncertain and
        # names BOTH labels so the review copy can quote them.
        beats = self._beats(32)
        lead = self._accents(beats, 3, 0.9, 0.4)
        accomp = self._accents(beats, 4, 0.9, 0.4)
        est = estimate_meter(
            beats,
            (),
            event_accents=lead,
            channel_accents={"accompaniment": accomp},
        )
        assert est.uncertain
        assert not est.refused
        assert est.confidence == 0.0
        assert {est.meter, est.runner_up} == {"3/4", "4/4"}

    def test_weak_consensus_reports_the_shared_guess(self) -> None:
        # Two pools that each weakly favour 4/4 agree on a guess even
        # though neither alone is trustworthy -- report it (still
        # uncertain, still review-flagged) instead of refusing.
        beats = self._beats(32)
        lead = self._accents(beats, 4, 0.9, 0.7)
        accomp = self._accents(beats, 4, 0.9, 0.68)
        solo = estimate_meter(beats, (), event_accents=lead)
        assert solo.meter == "4/4" and solo.uncertain and not solo.refused
        est = estimate_meter(
            beats,
            (),
            event_accents=lead,
            channel_accents={"accompaniment": accomp},
        )
        assert est.meter == "4/4"
        assert est.uncertain
        assert not est.refused
        # No dissenting channel label -- the reported rival is the
        # guess's own runner-up.
        assert est.runner_up == solo.runner_up

    def test_all_refused_stays_a_refusal(self) -> None:
        # Flat pools everywhere: no channel can justify a candidate,
        # so the fused verdict is an honest refusal — NOT a 4/4 guess.
        beats = self._beats(32)
        flat = tuple((t, 0.25) for t in beats)
        est = estimate_meter(
            beats,
            (),
            event_accents=flat,
            channel_accents={"accompaniment": flat},
        )
        assert est.refused
        assert est.uncertain
        assert est.confidence == 0.0

    def test_empty_channels_keep_the_strengths_fallback(self) -> None:
        # Empty pools must not mask the last-resort strengths read --
        # and an empty channel map is the single-pool path, not the
        # fused one.
        n = 24
        beats = self._beats(n)
        strengths = tuple(0.9 if i % 3 == 0 else 0.4 for i in range(n))
        est = estimate_meter(
            beats, strengths, (), {"accompaniment": ()}
        )
        assert est.meter == "3/4"
        est2 = estimate_meter(beats, strengths, (), {})
        assert est2.meter == "3/4"

    def test_refusal_flag_marks_default_not_a_guess(self) -> None:
        # _default() is a refusal; a real low-margin read is a guess.
        beats = self._beats(16)
        refused = estimate_meter(beats, (), ())
        assert refused.refused
        guessed = estimate_meter(
            beats, (), self._accents(beats, 4, 0.9, 0.7)
        )
        assert not guessed.refused


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


class TestKeyUncertainty:
    """#352: key estimates that cannot stand alone surface as review
    evidence — never a silently written signature."""

    def _analyze(
        self,
        notes: list[tuple[int, Fraction, Fraction]],
        measure_len: Fraction = Fraction(4),
    ):
        pitches = tuple(p for p, _o, _d in notes)
        onsets = tuple(o for _p, o, _d in notes)
        durs = tuple(d for _p, _o, d in notes)
        end = max((o + d for _p, o, d in notes), default=Fraction(0))
        starts = [Fraction(0)]
        pos = measure_len
        while pos <= end:
            starts.append(pos)
            pos += measure_len
        return analyze_key(pitches, onsets, durs, tuple(starts))

    def test_ambiguous_relative_candidates_flagged(self) -> None:
        # All white notes ending on G — two keys explain the material
        # almost equally well, so the written signature must not be
        # treated as settled.
        a = self._analyze(
            [
                (p, Fraction(i), Fraction(1))
                for i, p in enumerate((60, 62, 64, 65, 67, 69, 71, 67))
            ]
        )
        ev = key_uncertainty(a)
        assert ev is not None
        assert "close_candidates" in ev["details"]
        assert ev["runnerUpFifths"] is not None
        assert ev["keyMargin"] is not None and ev["keyMargin"] < 0.06
        assert ev["noteCount"] == 8

    def test_clear_key_not_flagged(self) -> None:
        a = self._analyze(
            [
                (p, Fraction(i), Fraction(1))
                for i, p in enumerate((60, 62, 64, 65, 67, 69, 71, 72))
            ]
        )
        assert key_uncertainty(a) is None

    def test_short_material_flagged(self) -> None:
        # Three notes correlate fine and still cannot carry a key.
        a = self._analyze(
            [
                (p, Fraction(i), Fraction(1))
                for i, p in enumerate((60, 64, 67))
            ]
        )
        ev = key_uncertainty(a)
        assert ev is not None
        assert "too_few_notes" in ev["details"]

    def test_empty_not_flagged(self) -> None:
        assert key_uncertainty(self._analyze([])) is None

    def test_harmony_override_names_the_arbitration(self) -> None:
        # #151: refine_key_with_harmony swaps the displaced melodic
        # winner in as runner_up — the head margin goes negative,
        # which is the structural signature of an override. The issue
        # must say that, not "close candidates" (margin -24% is not
        # a near-tie) or "low confidence" (the survivor's melodic
        # score being lower is what makes an override an override).
        from hornscribe.domain.score import KeySignature
        from hornscribe.transcription.key import KeyEstimate

        base = self._analyze(
            [
                (p, Fraction(i), Fraction(1))
                for i, p in enumerate((60, 62, 64, 65, 67, 69, 71, 72))
            ]
        )
        overridden = KeyEstimate(
            KeySignature(0, "minor"),
            0.488,
            KeySignature(1, "minor"),
            0.728,
        )
        a = replace(base, head=overridden, confidence=0.488)
        ev = key_uncertainty(a)
        assert ev is not None
        assert ev["details"] == ["harmony_override"]
        assert ev["keyMargin"] == -0.24
        assert ev["keyFifths"] == 0 and ev["keyMode"] == "minor"
        assert ev["runnerUpFifths"] == 1

    def test_uncertain_segment_identified(self) -> None:
        # 8 bars C major + 8 bars F# major (a real modulation the DP
        # splits) + 8 bars of drifting chromatic material the
        # estimator cannot pin down.
        notes: list[tuple[int, Fraction, Fraction]] = []
        t = Fraction(0)
        for pitches, measures in (
            ((60, 62, 64, 65, 67, 69, 71, 72), 8),
            ((66, 68, 70, 71, 73, 75, 77, 78), 8),
            ((61, 62, 63, 64), 8),
        ):
            for i in range(measures * 4):
                notes.append((pitches[i % len(pitches)], t + i, Fraction(1)))
            t += measures * 4
        a = self._analyze(notes)
        ev = key_uncertainty(a)
        assert ev is not None
        assert ev["details"] == ["segment_uncertain"]
        assert ev["uncertainSegments"] == [19]
        flagged = [
            s for s in ev["segments"] if s["uncertain"]
        ]
        assert len(flagged) == 1
        assert flagged[0]["measure"] == 19

    def test_pipeline_emits_key_uncertain_issue(
        self, tmp_path: Path
    ) -> None:
        log = run(
            tmp_path, make_events([60, 62, 64, 65, 67, 69, 71, 67])
        )
        assert log[-1]["phase"] == "completed"
        key_issues = [
            i
            for i in log[-1]["result"]["reviewIssues"]
            if i["reason"] == "key_uncertain"
        ]
        assert len(key_issues) == 1
        ev = key_issues[0]["evidence"]
        assert "close_candidates" in ev["details"]
        assert ev["keyFifths"] is not None
        # #352: the meta contract stays — same estimate, both places.
        meta = log[-1]["result"]["meta"]
        assert meta["keyConfidence"] == ev["keyConfidence"]

    def test_pipeline_clear_key_no_issue(self, tmp_path: Path) -> None:
        log = run(
            tmp_path, make_events([60, 62, 64, 65, 67, 69, 71, 72])
        )
        reasons = {i["reason"] for i in log[-1]["result"]["reviewIssues"]}
        assert "key_uncertain" not in reasons

    def test_key_hint_pins_signature(self, tmp_path: Path) -> None:
        # #53: a user-attested key must land on the score verbatim —
        # signature, mode, confidence and the chord prior all take the
        # hint, and no uncertainty review can fire on it.
        log = run(
            tmp_path,
            make_events([63, 65, 66, 68, 70, 63, 66, 68]),  # Eb-ish line
            {"keyHint": "Ebm"},
        )
        result = log[-1]["result"]
        meta = result["meta"]
        assert meta["keyFifths"] == -6
        assert meta["keyMode"] == "minor"
        assert meta["keyConfidence"] == 1.0
        assert meta["keyHinted"] is True
        assert meta["settings"]["keyHint"] == "Ebm"
        sig = result["scoreDocument"]["content"]["keySignature"]
        assert sig["fifths"] == -6
        assert sig["mode"] == "minor"
        # No key changes were detected — the hint pins the whole song.
        assert result["scoreDocument"]["content"].get("keyChanges", []) == []
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "key_uncertain" not in reasons

    def test_key_hint_auto_unchanged(self, tmp_path: Path) -> None:
        log = run(tmp_path, make_events([60, 62, 64, 65, 67, 69, 71, 72]))
        meta = log[-1]["result"]["meta"]
        assert meta["keyHinted"] is False
        assert meta["settings"]["keyHint"] == "auto"

    def test_key_hint_rejects_unknown_names(self) -> None:
        with pytest.raises(ValueError, match="keyHint"):
            TranscriptionParams.from_payload(
                {"audioPath": "a", "keyHint": "H#"}
            )
        p = TranscriptionParams.from_payload(
            {"audioPath": "a", "keyHint": "F#"}
        )
        sig = p.key_signature_hint()
        assert sig is not None
        assert (sig.fifths, sig.mode) == (6, "major")
        # "auto" resolves to None — analysis runs as before.
        assert (
            TranscriptionParams.from_payload(
                {"audioPath": "a"}
            ).key_signature_hint()
            is None
        )


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


class TestAutoRescueAndAccompaniment:
    """#204/#203: a detected mix under auto/melody tries vocal
    isolation before clipping to the top voice, and the companion
    accompaniment stem becomes a second score part.  These tests run
    without an injected backend — the real pipeline calls
    ``predict_note_events``/``vocal_wav``, stubbed here — because the
    rescue guard explicitly refuses to fire on an injected engine."""

    def _mix_events(self) -> tuple[RawNoteEvent, ...]:
        # Melody line + an overlapping lower line — 8 overlapping
        # pairs comfortably clears the 4-overlap/5% mix signature.
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
        return tuple(events)

    def _run_engine(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        predict: Any,
        params_extra: dict[str, Any] | None = None,
        vocal_wav_result: tuple | None = None,
        rescued: tuple[RawNoteEvent, ...] = (),
    ) -> list[dict[str, Any]]:
        import hornscribe.transcription.pipeline as pipeline_mod

        monkeypatch.setattr(pipeline_mod, "predict_note_events", predict)
        monkeypatch.setattr(
            pipeline_mod,
            "predict_note_events_rescued",
            lambda *a, **k: rescued,
        )
        if vocal_wav_result is not None:
            monkeypatch.setattr(
                pipeline_mod,
                "vocal_wav",
                lambda *a, **k: vocal_wav_result,
            )
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
            loader=fake_loader,
        )
        return collected

    def _stems(
        self, tmp_path: Path, with_accomp: bool = True
    ) -> tuple[str, str, bool, str, str]:
        vocal = tmp_path / "vocal.wav"
        vocal.write_bytes(b"x")
        if with_accomp:
            # accompaniment_wav_for derives the stem by name — the
            # file must exist beside the vocal WAV.
            (tmp_path / "vocal.accomp.wav").write_bytes(b"x")
        return (str(vocal), "applied", False, "demucs", "4.1.0")

    def test_auto_mix_rescues_through_isolation(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # #204: auto texture on a detected mix reaches for the
        # isolated stem instead of clipping to the top voice — the
        # rescue's own revision/preprocess lands on the result.
        calls: list[str] = []
        mix = self._mix_events()
        melody = make_events([72, 74, 76, 74, 72], beat_sec=0.5)

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            calls.append(str(path))
            return mix

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            # No accompaniment stem here — this test isolates the
            # rescue path; the staff is covered by the next tests.
            vocal_wav_result=self._stems(tmp_path, with_accomp=False),
            rescued=melody,
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        # The rescue line replaced the clipped mix — 5 notes, not 8+.
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 1
        assert len(parts[0]["notes"]) == 5
        pre = result["meta"]["preprocess"]
        assert pre["vocalIsolation"] is True
        assert pre["auto"] is True
        assert pre["method"] == "demucs"
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "vocal_isolation_applied" in reasons

    def test_accompaniment_stem_becomes_second_part(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # #203: the no_vocals stem beside the vocal is detected on the
        # same grid and lands as a second 伴奏 part — with its OWN
        # pitches, not the lead line's (id-collision guard).
        mix = self._mix_events()
        melody = make_events([72, 74, 76, 74, 72], beat_sec=0.5)
        backing = make_events([45, 45, 48, 48], beat_sec=1.0)
        calls: list[str] = []

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            calls.append(str(path))
            # Match the stem by FILENAME — the pytest tmp dir is named
            # after this test and itself contains 'accomp'.
            return backing if Path(path).name.endswith(".accomp.wav") else mix

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            vocal_wav_result=self._stems(tmp_path),
            rescued=melody,
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(calls) == 2  # take.wav + the .accomp.wav stem
        assert len(parts) == 2
        assert parts[1]["name"] == "伴奏"
        # The accompaniment staff is not a transposing instrument —
        # written exports keep it in the sounding projection.
        assert parts[1]["transposing"] is False
        accomp_pitches = {n["pitchMidi"] for n in parts[1]["notes"]}
        assert accomp_pitches == {45, 48}
        # Re-aliased ids stay unique across the merged document.
        ids = [n["id"] for p in parts for n in p["notes"]]
        assert len(ids) == len(set(ids))
        # raw_evidence.parts lines up 1:1 with score parts — any skew
        # makes requantize silently drop to the synthetic path.
        evidence = result["scoreDocument"]["rawEvidence"]
        assert len(evidence["parts"]) == len(parts)
        # #212: one informational provenance marker for the whole
        # separation-derived staff — not per-note flags.
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "accompaniment_part" in reasons

    def test_accompaniment_voices_merge_to_one_chordal_part(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # #213: simultaneous backing lines merge into ONE 伴奏 part —
        # aligned rhythms render as in-part chords, not extra staves.
        mix = self._mix_events()
        melody = make_events([72, 74, 76, 74, 72], beat_sec=0.5)
        backing: list[RawNoteEvent] = []
        for i in range(4):
            for pid, pitch in ((0, 40), (1, 57)):
                backing.append(
                    RawNoteEvent(
                        id=RawNoteEventId(f"rne-b{i * 2 + pid:06d}"),
                        transcription_revision=_REV,
                        pitch_midi=float(pitch),
                        onset_sec=float(i),
                        offset_sec=float(i) + 0.9,
                        confidence=0.9,
                        velocity=80,
                        source="test",
                    )
                )

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            return (
                tuple(backing)
                if Path(path).name.endswith(".accomp.wav")
                else mix
            )

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            vocal_wav_result=self._stems(tmp_path),
            rescued=melody,
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        # Both backing voices fold into ONE staff — never 伴奏 1/伴奏 2.
        assert len(parts) == 2
        assert parts[1]["name"] == "伴奏"
        assert parts[1]["transposing"] is False
        assert {n["pitchMidi"] for n in parts[1]["notes"]} == {40, 57}
        # Positional evidence parity still holds for requantize.
        evidence = result["scoreDocument"]["rawEvidence"]
        assert len(evidence["parts"]) == len(parts)

    def test_accompaniment_same_pitch_reattacks_survive(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # #132: a backing line re-articulating one pitch on every beat
        # with sub-30 ms gaps must keep every onset on the 伴奏 staff —
        # the lead-line merge gap used to fuse the whole run into one
        # long note, which is why real accompaniment staves read nearly
        # empty (bass quarters / repeated stabs are the norm there).
        mix = self._mix_events()
        melody = make_events([72, 74, 76, 74, 72], beat_sec=0.5)
        backing = tuple(
            RawNoteEvent(
                id=RawNoteEventId(f"rne-b{i:06d}"),
                transcription_revision=_REV,
                pitch_midi=45.0,
                onset_sec=float(i),
                offset_sec=float(i) + 0.98,
                confidence=0.9,
                velocity=80,
                source="test",
            )
            for i in range(4)
        )

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            return (
                backing
                if Path(path).name.endswith(".accomp.wav")
                else mix
            )

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            vocal_wav_result=self._stems(tmp_path),
            rescued=melody,
        )
        assert log[-1]["phase"] == "completed"
        parts = log[-1]["result"]["scoreDocument"]["content"]["parts"]
        assert len(parts) == 2
        assert len(parts[1]["notes"]) == 4
        assert {n["pitchMidi"] for n in parts[1]["notes"]} == {45}

    def test_accompaniment_part_opt_out(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # accompanimentPart=False: the stem exists but no second
        # staff is generated — the opt-out is honoured end to end.
        mix = self._mix_events()

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            if Path(path).name.endswith(".accomp.wav"):
                return self._mix_events()
            return mix

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            params_extra={"accompanimentPart": False},
            vocal_wav_result=self._stems(tmp_path),
            rescued=make_events([72, 74], beat_sec=0.5),
        )
        assert log[-1]["phase"] == "completed"
        parts = log[-1]["result"]["scoreDocument"]["content"]["parts"]
        assert len(parts) == 1

    def test_no_accompaniment_stem_stays_single_part(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Solo-ish source: separation produced no accompaniment stem
        # (or it was near-silent and dropped) — no empty second staff.
        mix = self._mix_events()
        calls: list[str] = []

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            calls.append(str(path))
            return mix

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            vocal_wav_result=self._stems(tmp_path, with_accomp=False),
            rescued=make_events([72, 74], beat_sec=0.5),
        )
        assert log[-1]["phase"] == "completed"
        parts = log[-1]["result"]["scoreDocument"]["content"]["parts"]
        assert len(parts) == 1
        # predict ran exactly once — the accomp stem never existed,
        # so no second detection pass fired either. (Basename check:
        # the pytest tmp dir itself may contain 'accomp'.)
        assert all(not Path(c).name.endswith(".accomp.wav") for c in calls)
        assert len(calls) == 1

    def test_accompaniment_notes_get_no_per_note_flags(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # #249: per-note checks (horn range / model confidence /
        # very-short detection) are horn-staff business. The
        # separation-derived accompaniment part is covered by the one
        # accompaniment_part provenance marker (#212) — flagging its
        # notes flooded the review list with piano-bass "outside horn
        # range" cautions.
        mix = self._mix_events()
        melody = make_events([72, 74, 76, 74, 72], beat_sec=0.5)
        backing = [
            # Deep bass: EXTREME outside the written horn range.
            RawNoteEvent(
                id=RawNoteEventId("rne-b000001"),
                transcription_revision=_REV,
                pitch_midi=33.0,
                onset_sec=0.0,
                offset_sec=0.9,
                confidence=0.9,
                velocity=80,
                source="test",
            ),
            # Survives the confidence floor (0.35 + 0.5s sustain) yet
            # sits below LOW_CONFIDENCE — a pre-fix low_model_confidence
            # flag waiting to happen.
            RawNoteEvent(
                id=RawNoteEventId("rne-b000002"),
                transcription_revision=_REV,
                pitch_midi=40.0,
                onset_sec=1.0,
                offset_sec=1.5,
                confidence=0.4,
                velocity=80,
                source="test",
            ),
            # Confident but 50 ms — pre-fix very_short_detection.
            RawNoteEvent(
                id=RawNoteEventId("rne-b000003"),
                transcription_revision=_REV,
                pitch_midi=45.0,
                onset_sec=2.0,
                offset_sec=2.05,
                confidence=0.9,
                velocity=80,
                source="test",
            ),
        ]

        def _predict(path: str, **kw: Any) -> tuple[RawNoteEvent, ...]:
            return (
                tuple(backing)
                if Path(path).name.endswith(".accomp.wav")
                else mix
            )

        log = self._run_engine(
            tmp_path,
            monkeypatch,
            _predict,
            vocal_wav_result=self._stems(tmp_path),
            rescued=melody,
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        parts = result["scoreDocument"]["content"]["parts"]
        assert len(parts) == 2
        assert parts[1]["transposing"] is False
        accomp_note_ids = {n["id"] for n in parts[1]["notes"]}
        assert accomp_note_ids  # the fixture must actually emit notes
        flagged = {
            nid
            for issue in result["reviewIssues"]
            + result.get("omittedReviewIssues", [])
            for nid in issue.get("canonicalNoteIds", [])
        }
        assert not (accomp_note_ids & flagged)
        # The single provenance marker still describes the staff.
        reasons = {i["reason"] for i in result["reviewIssues"]}
        assert "accompaniment_part" in reasons

    def test_mono_texture_never_rescues(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A declared-mono source stays on the raw path even with the
        # same overlap signature — the rescue is an auto/melody remedy.
        import hornscribe.transcription.pipeline as pipeline_mod

        mix = self._mix_events()
        vocal_calls: list[bool] = []
        monkeypatch.setattr(
            pipeline_mod,
            "vocal_wav",
            lambda *a, **k: vocal_calls.append(True)
            or (None, "x", False, None, None),
        )
        monkeypatch.setattr(
            pipeline_mod,
            "predict_note_events_pyin",
            lambda *a, **k: mix,
        )
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()
        params = TranscriptionParams.from_payload(
            {
                "audioPath": str(audio),
                "tempoBpm": 120.0,
                "meter": "4/4",
                "texture": "mono",
            }
        )
        run_transcription_job(
            job_id="job-0001",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            loader=fake_loader,
        )
        assert collected[-1]["phase"] == "completed"
        assert vocal_calls == []



class TestOmittedIssues:
    """#360: the 60-issue surfacing cap keeps the omitted tail inside
    the result — with real allocated ids — so the desktop can expand
    it on demand instead of dropping the detections."""

    def _run_long(
        self, tmp_path: Path, events: tuple[RawNoteEvent, ...]
    ) -> list[dict[str, Any]]:
        audio = tmp_path / "take.wav"
        audio.write_bytes(b"x" * 64)
        collected, emit = collect()
        params = TranscriptionParams.from_payload(
            {
                "audioPath": str(audio),
                "tempoBpm": 120.0,
                "meter": "4/4",
            }
        )
        run_transcription_job(
            job_id="job-0001",
            params=params,
            emit=emit,
            cancel=threading.Event(),
            backend=lambda _p: events,
            # 45s of silence — the 70-event run spans ~35s.
            loader=lambda _p: (array("f", [0.0] * (22050 * 45)), 22050),
        )
        return collected

    def test_cap_defers_tail_with_real_ids(
        self, tmp_path: Path
    ) -> None:
        # 70 low-confidence notes -> 70 extra issues; the cap surfaces
        # 60 and defers the remaining 10 verbatim.
        log = self._run_long(
            tmp_path,
            make_events([60 + (i % 12) for i in range(70)], confidence=0.2),
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        omitted = result["omittedReviewIssues"]
        assert len(omitted) == 10
        assert all(i["reason"] == "low_model_confidence" for i in omitted)
        surfaced = [
            i
            for i in result["reviewIssues"]
            if i["reason"] == "low_model_confidence"
        ]
        assert len(surfaced) == 60
        # Deferred ids were allocated like any other issue — unique,
        # non-empty, disjoint from the surfaced set.
        surfaced_ids = {i["id"] for i in result["reviewIssues"]}
        omitted_ids = {i["id"] for i in omitted}
        assert len(omitted_ids) == 10
        assert "" not in omitted_ids
        assert omitted_ids.isdisjoint(surfaced_ids)
        assert result["meta"]["reviewSummary"]["omitted"] == 10

    def test_no_omissions_emits_empty_list(self, tmp_path: Path) -> None:
        log = run(tmp_path, make_events([60, 62, 64, 65]))
        assert log[-1]["phase"] == "completed"
        assert log[-1]["result"]["omittedReviewIssues"] == []


class TestAutoMeterFallback:
    """#24: an uncertain auto-meter estimate must never be written —
    the meter.py contract is 4/4 fallback + a meter_conflict issue
    carrying the rejected guess (a misread 6/8 once printed
    "♩=37.45" for a ~108 bpm source)."""

    def _run_with_meter_est(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        meter_est: Any,
    ) -> list[dict[str, Any]]:
        import hornscribe.transcription.pipeline as pipeline_mod

        monkeypatch.setattr(
            pipeline_mod,
            "_track_beats",
            lambda _s, _sr: (
                tuple(i * 0.55 for i in range(8)),
                tuple(1.0 for _ in range(8)),
            ),
        )
        monkeypatch.setattr(
            pipeline_mod,
            "estimate_meter",
            lambda _b, _s, **_kw: meter_est,
        )
        return run(
            tmp_path,
            make_events([60, 62, 64, 65, 67, 69, 71, 72], beat_sec=0.5),
            {"meter": "auto"},
        )

    def test_uncertain_guess_writes_4_4_and_reports_guess(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from hornscribe.transcription.meter import MeterEstimate

        log = self._run_with_meter_est(
            tmp_path,
            monkeypatch,
            MeterEstimate(
                meter="6/8",
                confidence=0.0,
                tracked_eighths=True,
                uncertain=True,
                runner_up="3/4",
            ),
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        # The score keeps the readable default; the rejected guess
        # survives only as review evidence.
        assert result["meta"]["meter"] == "4/4"
        ts = result["scoreDocument"]["content"]["timeSignature"]
        assert (ts["beatsPerMeasure"], ts["beatUnit"]) == (4, 4)
        conflicts = [
            i for i in result["reviewIssues"] if i["reason"] == "meter_conflict"
        ]
        assert conflicts, "uncertain auto meter must surface meter_conflict"
        assert conflicts[0]["evidence"]["estimatedMeter"] == "6/8"
        # #264: the runner-up label rides the issue — the ambiguity the
        # confidence margin describes ('6/8 vs 3/4') is what the user
        # judges, not a bare 0.0.
        assert conflicts[0]["evidence"]["runnerUpMeter"] == "3/4"

    def test_refused_estimate_reports_no_candidate(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from hornscribe.transcription.meter import MeterEstimate

        # #147: a refusal is not a 4/4 guess — the evidence must carry
        # no estimatedMeter so the UI shows its 'undecidable' copy
        # instead of 'candidates: 4/4, wrote 4/4'.
        log = self._run_with_meter_est(
            tmp_path,
            monkeypatch,
            MeterEstimate(
                meter="4/4",
                confidence=0.0,
                tracked_eighths=False,
                uncertain=True,
                refused=True,
            ),
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        assert result["meta"]["meter"] == "4/4"
        conflicts = [
            i for i in result["reviewIssues"] if i["reason"] == "meter_conflict"
        ]
        assert conflicts
        assert conflicts[0]["evidence"]["estimatedMeter"] is None

    def test_trusted_compound_meter_still_writes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from hornscribe.transcription.meter import MeterEstimate

        log = self._run_with_meter_est(
            tmp_path,
            monkeypatch,
            MeterEstimate(
                meter="6/8",
                confidence=0.8,
                tracked_eighths=True,
                uncertain=False,
                tracked_unit_ql=Fraction(1, 2),
            ),
        )
        assert log[-1]["phase"] == "completed"
        result = log[-1]["result"]
        assert result["meta"]["meter"] == "6/8"
        ts = result["scoreDocument"]["content"]["timeSignature"]
        assert (ts["beatsPerMeasure"], ts["beatUnit"]) == (6, 8)

class TestStemBleedDrop:
    """#236: accompaniment-stem bleed dropped from the lead track."""

    def _lead(self, events: tuple[RawNoteEvent, ...]) -> CleanedEvents:
        return CleanedEvents(
            events=events,
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )

    def _ev(
        self,
        midi: float,
        onset: float,
        offset: float,
        i: int = 0,
        src: str = "test",
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-t{i + 1:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.9,
            velocity=80,
            source=src,
        )

    def test_corroborated_low_bleed_dropped(self) -> None:
        # melodic median ~62; a midi-45 fragment the accompaniment
        # holds pitch-for-pitch is bleed, not melody.
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (self._ev(45.0, 30.0, 30.4, 90),)
        )
        accomp = [
            self._lead((self._ev(45.2, 29.9, 30.6, 91),))
        ]
        out = _drop_stem_bleed_lows(lead, accomp)
        assert len(out.events) == 24
        assert out.bleed_dropped == 1
        assert all(e.pitch_midi > 45.5 for e in out.events)

    def test_vocal_only_low_note_kept(self) -> None:
        # A low note the accompaniment cannot explain survives --
        # genuine low male vocals sit in this band.
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (self._ev(42.0, 30.0, 30.4, 90),)
        )
        accomp = [self._lead((self._ev(64.0, 29.9, 30.6, 91),))]
        out = _drop_stem_bleed_lows(lead, accomp)
        assert len(out.events) == 25
        assert out.bleed_dropped == 0

    def test_sub_d2_dropped_without_match(self) -> None:
        # Below D2 a melodic line is never a usable lead vocal.
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (self._ev(33.0, 30.0, 30.4, 90),)
        )
        accomp = [self._lead((self._ev(64.0, 29.9, 30.6, 91),))]
        out = _drop_stem_bleed_lows(lead, accomp)
        assert len(out.events) == 24
        assert out.bleed_dropped == 1

    def test_fragment_inside_bleed_span_dropped(self) -> None:
        # An uncorroborated sub-floor note sandwiched between dropped
        # bleed notes belongs to the same span.
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (
                self._ev(45.0, 30.0, 30.3, 90),
                self._ev(44.0, 30.35, 30.5, 91),
                self._ev(45.0, 30.55, 30.8, 92),
            )
        )
        accomp = [
            self._lead(
                (
                    self._ev(45.1, 29.9, 30.35, 93),
                    self._ev(45.3, 30.5, 30.9, 94),
                )
            )
        ]
        out = _drop_stem_bleed_lows(lead, accomp)
        assert len(out.events) == 24
        assert out.bleed_dropped == 3

    def test_in_band_unison_kept(self) -> None:
        # Melody doubling the accompaniment inside the vocal band is
        # real -- register floor only reaches below median-15st.
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (self._ev(55.0, 30.0, 30.4, 90),)
        )
        accomp = [self._lead((self._ev(55.0, 29.9, 30.6, 91),))]
        out = _drop_stem_bleed_lows(lead, accomp)
        assert len(out.events) == 25
        assert out.bleed_dropped == 0

    def test_no_accomp_no_drops(self) -> None:
        lead = self._lead(
            make_events([60, 62, 64] * 8)
            + (self._ev(45.0, 30.0, 30.4, 90),)
        )
        out = _drop_stem_bleed_lows(lead, [])
        assert len(out.events) == 25
        assert out.bleed_dropped == 0


class TestStemLatticeAdmission:
    """#200: suppressed lattice candidates the stem corroborates are
    re-admitted into the cleaned lead line — register window,
    support count, and fundamental-band arbitration all gate the
    rescue so bleed never earns a slot."""

    def _stem(self, spans: list[tuple[float, float, float]]):
        """Synthesize a mono stem buffer: a sine at each (onset,
        offset, midi) span — the vocal estimate's honest content."""
        np = pytest.importorskip("numpy")
        sr = 22050
        n = int(sr * 8.0)
        y = np.zeros(n, dtype=np.float64)
        t = np.arange(n) / sr
        for on, off, midi in spans:
            f = 440.0 * 2.0 ** ((midi - 69) / 12.0)
            mask = (t >= on) & (t < off)
            y[mask] += 0.5 * np.sin(2 * np.pi * f * t[mask])
        return (y, sr)

    def _lead(self, events: tuple[RawNoteEvent, ...]) -> CleanedEvents:
        return CleanedEvents(
            events=events,
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )

    def _ev(
        self,
        midi: float,
        onset: float,
        offset: float,
        i: int = 0,
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-t{i + 1:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.9,
            velocity=80,
            source="test",
        )

    def test_corroborated_suppressed_note_admitted(self) -> None:
        """Two lattice fragments at midi 72 sit in the gap between
        surviving 74s — the stem carries a real 72 sine there, so the
        note is re-admitted."""
        kept = self._lead(
            (
                self._ev(74.0, 0.4, 0.9, 1),
                self._ev(74.0, 1.9, 2.4, 2),
            )
        )
        ranged = tuple(kept.events) + (
            self._ev(72.0, 1.0, 1.3, 3),
            self._ev(72.0, 1.3, 1.6, 4),
        )
        stem = self._stem(
            [(0.4, 0.9, 74.0), (1.0, 1.6, 72.0), (1.9, 2.4, 74.0)]
        )
        out, margins = _admit_stem_lattice_candidates(kept, ranged, stem)
        assert len(out.events) == 3
        admitted = [e for e in out.events if int(round(e.pitch_midi)) == 72]
        assert len(admitted) == 1
        assert admitted[0].onset_sec == pytest.approx(1.0, abs=0.02)
        assert admitted[0].id in margins

    def test_single_supporter_never_admitted(self) -> None:
        """A lone lattice flicker under the same stem evidence is
        not real support — the two-event floor holds."""
        kept = self._lead(
            (
                self._ev(74.0, 0.4, 0.9, 1),
                self._ev(74.0, 1.9, 2.4, 2),
            )
        )
        ranged = tuple(kept.events) + (self._ev(72.0, 1.0, 1.6, 3),)
        stem = self._stem(
            [(0.4, 0.9, 74.0), (1.0, 1.6, 72.0), (1.9, 2.4, 74.0)]
        )
        out, margins = _admit_stem_lattice_candidates(kept, ranged, stem)
        assert len(out.events) == 2
        assert margins == {}

    def test_out_of_register_candidate_rejected(self) -> None:
        """A corroborated sub-bass hypothesis stays out — the local
        line sits ~24 st above it."""
        kept = self._lead(
            (
                self._ev(74.0, 0.4, 0.9, 1),
                self._ev(74.0, 1.9, 2.4, 2),
            )
        )
        ranged = tuple(kept.events) + (
            self._ev(48.0, 1.0, 1.3, 3),
            self._ev(48.0, 1.3, 1.6, 4),
        )
        stem = self._stem(
            [(0.4, 0.9, 74.0), (1.0, 1.6, 48.0), (1.9, 2.4, 74.0)]
        )
        out, margins = _admit_stem_lattice_candidates(kept, ranged, stem)
        assert len(out.events) == 2
        assert margins == {}

    def test_band_loser_rejected(self) -> None:
        """A rival suppressed candidate whose band dominates the
        span keeps the weaker one out."""
        kept = self._lead(
            (
                self._ev(74.0, 0.4, 0.9, 1),
                self._ev(74.0, 1.9, 2.4, 2),
            )
        )
        ranged = tuple(kept.events) + (
            self._ev(72.0, 1.0, 1.3, 3),
            self._ev(72.0, 1.3, 1.6, 4),
            self._ev(70.0, 1.0, 1.3, 5),
            self._ev(70.0, 1.3, 1.6, 6),
        )
        # Stem carries 72 loud, 70 faint — 70 loses the band check.
        np = pytest.importorskip("numpy")
        sr = 22050
        n = int(sr * 8.0)
        y = np.zeros(n, dtype=np.float64)
        t = np.arange(n) / sr
        for on, off, midi, amp in (
            (0.4, 0.9, 74.0, 0.5),
            (1.0, 1.6, 72.0, 0.5),
            (1.0, 1.6, 70.0, 0.06),
            (1.9, 2.4, 74.0, 0.5),
        ):
            f = 440.0 * 2.0 ** ((midi - 69) / 12.0)
            mask = (t >= on) & (t < off)
            y[mask] += amp * np.sin(2 * np.pi * f * t[mask])
        out, _margins = _admit_stem_lattice_candidates(
            kept, ranged, (y, sr)
        )
        pitches = sorted(int(round(e.pitch_midi)) for e in out.events)
        assert pitches == [72, 74, 74]

    def test_no_stem_passthrough(self) -> None:
        kept = self._lead((self._ev(74.0, 0.4, 0.9, 1),))
        out, margins = _admit_stem_lattice_candidates(kept, (), None)
        assert out is kept
        assert margins == {}

class TestAccompConfidenceFloor:
    """#244: the other-stem flicker floor keeps confident or sustained
    notes and drops short sub-threshold detections."""

    def _ev(
        self, midi: float, onset: float, offset: float, conf, i: int = 0
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-t{i + 1:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=conf,
            velocity=80,
            source="test",
        )

    def test_confident_notes_always_kept(self) -> None:
        ev = (
            self._ev(60.0, 0.0, 0.1, 0.9),
            self._ev(62.0, 0.2, 0.25, 0.7),
        )
        assert len(_accomp_confidence_floor(ev)) == 2

    def test_short_low_confidence_dropped(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.1, 0.4),)
        assert _accomp_confidence_floor(ev) == ()

    def test_sustained_mid_confidence_kept(self) -> None:
        # 0.4 conf but 0.5 s long -- a real sustained pad tone.
        ev = (self._ev(60.0, 0.0, 0.5, 0.4),)
        assert len(_accomp_confidence_floor(ev)) == 1

    def test_hard_floor_drops_long_weak_notes(self) -> None:
        # Below the sustain floor even a long note is noise.
        ev = (self._ev(60.0, 0.0, 1.0, 0.2),)
        assert _accomp_confidence_floor(ev) == ()

    def test_boundary_values(self) -> None:
        ev = (
            self._ev(60.0, 0.0, 0.1, 0.5, 1),   # conf at keep line
            self._ev(62.0, 0.2, 0.5, 0.35, 2),  # floor conf + sustain
            self._ev(64.0, 0.5, 0.79, 0.35, 3), # sustain 1 ms short
        )
        out = _accomp_confidence_floor(ev)
        assert [e.pitch_midi for e in out] == [60.0, 62.0]

    def test_none_confidence_dropped(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.5, None),)
        assert _accomp_confidence_floor(ev) == ()


class TestDedupAccompUnison:
    """#155: a contained same-pitch event is one physical tone
    detected twice — across voices the merge inside clean_monophonic
    can never see it, so the shorter duplicate is dropped here."""

    def _ev(
        self,
        midi: float,
        onset: float,
        offset: float,
        i: int = 0,
        src: str = "test",
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-t{i + 1:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.9,
            velocity=80,
            source=src,
        )

    class _FakeRuns:
        """run_start answers for the overlap-union pass (#155).

        Keys may be ``midi`` (one answer for every onset) or
        ``(midi, round(onset, 2))`` for per-onset answers (#172)."""

        def __init__(self, starts: dict[object, float | None]) -> None:
            self._starts = starts

        def run_start(
            self, midi: float, onset_sec: float
        ) -> float | None:
            key = (int(round(midi)), round(onset_sec, 2))
            if key in self._starts:
                return self._starts[key]
            return self._starts.get(int(round(midi)))

    def _voice(self, *evs: RawNoteEvent) -> CleanedEvents:
        return CleanedEvents(
            events=evs,
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )

    def test_contained_duplicate_dropped_across_voices(self) -> None:
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(60.0, 0.0, 1.0, 1)),
                self._voice(self._ev(60.0, 0.2, 0.4, 2)),
            ]
        )
        assert [e.pitch_midi for c in out for e in c.events] == [60.0]

    def test_identical_twins_keep_first(self) -> None:
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(57.0, 0.0, 0.9, 1)),
                self._voice(self._ev(57.0, 0.0, 0.9, 2)),
            ]
        )
        total = sum(len(c.events) for c in out)
        assert total == 1

    def test_mutual_tolerance_pair_keeps_the_longer(self) -> None:
        # #185 (pad8th m59@14.5): inside _ACCOMP_UNISON_TOL_SEC each
        # event 'contains' the other, so the old rule killed BOTH --
        # the shorter via 'longer wins' and the longer via 'first
        # listed' -- and two covers of one strike died together.
        # Now the strictly longer twin is the single survivor.
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(59.0, 14.533, 14.986, 1)),   # det
                self._voice(self._ev(59.0, 14.512, 15.000, 2)),   # mined
            ]
        )
        kept = [e for c in out for e in c.events]
        assert len(kept) == 1
        assert kept[0].onset_sec == pytest.approx(14.512)
        assert kept[0].offset_sec == pytest.approx(15.000)

    def test_longer_first_twin_still_wins(self) -> None:
        # The unchanged direction: a longer cover listed first drops
        # the shorter twin exactly as before.
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(59.0, 14.512, 15.000, 1)),
                self._voice(self._ev(59.0, 14.533, 14.986, 2)),
            ]
        )
        kept = [e for c in out for e in c.events]
        assert len(kept) == 1
        assert kept[0].onset_sec == pytest.approx(14.512)

    def test_different_pitch_untouched(self) -> None:
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(60.0, 0.0, 1.0, 1)),
                self._voice(self._ev(64.0, 0.1, 0.9, 2)),
            ]
        )
        total = sum(len(c.events) for c in out)
        assert total == 2

    def test_adjacent_same_pitch_kept(self) -> None:
        # A re-articulation AFTER the longer note ended is a real
        # second note, not a contained duplicate.
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(45.0, 0.0, 0.5, 1)),
                self._voice(self._ev(45.0, 0.6, 0.9, 2)),
            ]
        )
        total = sum(len(c.events) for c in out)
        assert total == 2

    def test_mined_anchor_unions_detected_overlap(self) -> None:
        # The phantom-onset shape: a mined run from 0.0 and a detected
        # onset at 0.44 the band traces back to the run's start — one
        # held tone, so the pair unions into the mined event's head.
        bands = self._FakeRuns({64: 0.0})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.44, 1.79, 1),
                    self._ev(64.0, 0.0, 0.49, 2, src="pad-completion"),
                )
            ],
            bands,
        )
        evs = [e for c in out for e in c.events]
        assert len(evs) == 1
        assert evs[0].onset_sec == pytest.approx(0.0)
        assert evs[0].offset_sec == pytest.approx(1.79)

    def test_detected_first_mined_inside_is_a_reattack(self) -> None:
        # The mirror shape: a fresh mined run opening inside a
        # detected span is the miner's own re-attack signature —
        # both events stay even though the run reaches back.
        bands = self._FakeRuns({60: 7.5})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(60.0, 7.5, 10.68, 1),
                    self._ev(60.0, 9.36, 11.21, 2, src="pad-completion"),
                )
            ],
            bands,
        )
        assert sum(len(c.events) for c in out) == 2

    def test_overlap_union_needs_band_evidence(self) -> None:
        # No stem, no verdict — a detected+mined overlap stands.
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.44, 1.79, 1),
                    self._ev(64.0, 0.0, 0.49, 2, src="pad-completion"),
                )
            ]
        )
        assert sum(len(c.events) for c in out) == 2

    def test_detected_pair_overlap_never_unions(self) -> None:
        # Two detector events can be a real re-attack — without a
        # mined anchor the band's reach-back is not enough.
        bands = self._FakeRuns({64: 0.0})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.0, 0.49, 1),
                    self._ev(64.0, 0.44, 1.79, 2),
                )
            ],
            bands,
        )
        assert sum(len(c.events) for c in out) == 2

    def test_overlap_union_run_miss_keeps_pair(self) -> None:
        # The later onset's run starts at itself — a genuine attack
        # inside a held tone (the band rose under it), not a phantom.
        bands = self._FakeRuns({64: 0.44})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.0, 0.49, 1, src="pad-completion"),
                    self._ev(64.0, 0.44, 1.79, 2),
                )
            ],
            bands,
        )
        assert sum(len(c.events) for c in out) == 2

    def test_later_mined_fragment_unions_into_grown_run(self) -> None:
        # #172: the miner split one held tone across a local mask dip;
        # the grown union (mined anchor + tracker onset folded in)
        # already covers the fragment's span, and the fragment's own
        # run reaches back to the union's onset — same tone, union.
        bands = self._FakeRuns({64: 0.0})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.0, 1.0, 1, src="pad-completion"),
                    self._ev(64.0, 0.1, 1.4, 2, src="basic_pitch"),
                    self._ev(64.0, 1.2, 1.45, 3, src="pad-completion"),
                )
            ],
            bands,
        )
        evs = [e for c in out for e in c.events]
        assert len(evs) == 1
        assert evs[0].offset_sec == pytest.approx(1.45)

    def test_later_run_mined_fragment_kept(self) -> None:
        # #172 kept-side: a mined fragment overlapping the grown
        # union whose own run starts LATER is a fresh re-strike
        # inside the sustained span — not a shard of the union.
        bands = self._FakeRuns({(64, 0.1): 0.0, (64, 1.2): 1.2})
        out = _dedup_accomp_unison(
            [
                self._voice(
                    self._ev(64.0, 0.0, 1.0, 1, src="pad-completion"),
                    self._ev(64.0, 0.1, 1.4, 2, src="basic_pitch"),
                    self._ev(64.0, 1.2, 1.45, 3, src="pad-completion"),
                )
            ],
            bands,
        )
        assert sum(len(c.events) for c in out) == 2

    def test_empty_and_singleton_passthrough(self) -> None:
        assert _dedup_accomp_unison([]) == []
        single = [self._voice(self._ev(60.0, 0.0, 0.5, 1))]
        out = _dedup_accomp_unison(single)
        assert sum(len(c.events) for c in out) == 1

    def test_strike_train_cover_dies_members_survive(self) -> None:
        # #189 (hard-vocal m72): the backend emitted one strummed
        # arpeggio member twice -- a merged 0.232-1.858 span in one
        # voice and the real three-strike train in another. Interior
        # re-fires at distinct attack times prove the cover is a
        # merged strike train, not one held tone: the cover dies and
        # the train survives whole (the edge-aligned 0.244 member is
        # the first strike, not a duplicate of it).
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(72.0, 0.232, 1.858, 1)),
                self._voice(
                    self._ev(72.0, 0.244, 0.464, 2),
                    self._ev(72.0, 0.708, 0.929, 3),
                    self._ev(72.0, 1.184, 1.405, 4),
                ),
            ]
        )
        kept = sorted(e.onset_sec for c in out for e in c.events)
        assert kept == pytest.approx([0.244, 0.708, 1.184])

    def test_interior_twins_one_attack_time_not_a_train(self) -> None:
        # Two interior events at the SAME attack time are a doubled
        # detection of one tone, not a strike train -- containment
        # still drops them and the cover stands.
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(60.0, 0.0, 1.0, 1)),
                self._voice(
                    self._ev(60.0, 0.3, 0.5, 2),
                    self._ev(60.0, 0.3, 0.55, 3),
                ),
            ]
        )
        kept = [e for c in out for e in c.events]
        assert len(kept) == 1
        assert kept[0].onset_sec == pytest.approx(0.0)

    def test_mined_interior_fragments_are_not_train_evidence(
        self,
    ) -> None:
        # The miner can split one held tone across a mask dip (#172),
        # so interior pad-completion fragments carry no re-strike
        # verdict -- the cover still absorbs them.
        out = _dedup_accomp_unison(
            [
                self._voice(self._ev(64.0, 0.0, 1.9, 1)),
                self._voice(
                    self._ev(64.0, 0.4, 0.7, 2, src="pad-completion"),
                    self._ev(64.0, 1.1, 1.4, 3, src="pad-completion"),
                ),
            ]
        )
        kept = [e for c in out for e in c.events]
        assert len(kept) == 1
        assert kept[0].offset_sec == pytest.approx(1.9)


class TestAccompTrainCompletion:
    """#191: a periodic same-pitch train mints the hits the detector
    under-fired — but only inside a dead strike cover's span (the
    detector's own merged hypothesis) and only where the band
    envelope still rose at the predicted lattice point."""

    class _FakeBands:
        _spf = 0.02

        def __init__(
            self, rises: dict[int, list[tuple[float, float, float]]]
        ) -> None:
            self._rises = rises

        def band_reattack(
            self, midi: float, onset_sec: float
        ) -> float | None:
            out = 0.0
            for lo, hi, r in self._rises.get(int(round(midi)), ()):
                if lo <= onset_sec <= hi:
                    out = max(out, r)
            return out

        def band_neighbor_reattack(
            self, midi: float, onset_sec: float
        ) -> float:
            m = int(round(midi))
            best = 0.0
            for mm in range(m - 3, m + 4):
                if mm == m:
                    continue
                r = self.band_reattack(mm, onset_sec)
                if r is not None and r > best:
                    best = r
            return best

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-b{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            velocity=80,
            source="test",
        )

    def _voice(self, *evs: RawNoteEvent) -> CleanedEvents:
        return CleanedEvents(
            events=evs,
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )

    def _train_voice(self) -> CleanedEvents:
        # Three detected strikes at ~0.47 s establish the lattice;
        # the fourth (truth ~1.64) was never emitted.
        return self._voice(
            self._ev(72.0, 0.244, 0.464, 1),
            self._ev(72.0, 0.708, 0.928, 2),
            self._ev(72.0, 1.184, 1.404, 3),
            self._ev(72.0, 2.346, 2.566, 4),
        )

    def test_mints_strike_inside_dead_cover(self) -> None:
        # The hard-vocal m72 shape: cover 0.232-1.858 died to the
        # strike train; the missed 4th hit sits inside its span with
        # a band rise at the lattice point.
        bands = self._FakeBands({72: [(1.55, 1.80, 7.0)]})
        out = _accomp_train_completion(
            [self._train_voice()],
            bands,
            _REV,
            evidence=[(72, 0.232, 1.858)],
        )
        minted = [
            e for c in out for e in c.events
            if e.source == "train-completion"
        ]
        assert len(minted) == 1
        assert minted[0].onset_sec == pytest.approx(1.66, abs=0.13)
        assert int(round(minted[0].pitch_midi)) == 72

    def test_no_evidence_mints_nothing(self) -> None:
        bands = self._FakeBands({72: [(1.55, 1.80, 7.0)]})
        voice = self._train_voice()
        out = _accomp_train_completion([voice], bands, _REV)
        assert [e for c in out for e in c.events] == list(voice.events)

    def test_candidate_outside_cover_refused(self) -> None:
        # The predicted 2.14 point is past the dead cover's end —
        # no detector span ever claimed it, so even a strong band
        # rise cannot mint there.
        bands = self._FakeBands({72: [(2.0, 2.2, 7.0)]})
        out = _accomp_train_completion(
            [self._train_voice()],
            bands,
            _REV,
            evidence=[(72, 0.232, 1.858)],
        )
        assert not [
            e for c in out for e in c.events
            if e.source == "train-completion"
        ]

    def test_no_rise_at_covered_candidate_refused(self) -> None:
        # Covered by a dead cover but the band stayed flat through
        # the lattice point — a rest, not a miss.
        bands = self._FakeBands({72: [(1.55, 1.80, 0.4)]})
        out = _accomp_train_completion(
            [self._train_voice()],
            bands,
            _REV,
            evidence=[(72, 0.232, 1.858)],
        )
        assert not [
            e for c in out for e in c.events
            if e.source == "train-completion"
        ]

    def test_merged_pair_long_event_splits(self) -> None:
        # #193 (hard-vocal m41): the 9.374-10.328 event spans exactly
        # 2x the bass train's period — two strikes the detector
        # merged. The low band saturates (own rise ~0) but the
        # strike's thump still rises the +-3-semitone neighborhood.
        voice = self._voice(
            self._ev(41.0, 1.892, 2.346, 1),
            self._ev(41.0, 2.346, 2.823, 2),
            self._ev(41.0, 2.823, 3.275, 3),
            self._ev(41.0, 3.275, 3.740, 4),
            self._ev(41.0, 9.374, 10.328, 5),
            self._ev(41.0, 10.328, 10.780, 6),
            self._ev(41.0, 10.780, 11.245, 7),
        )
        bands = self._FakeBands({44: [(9.80, 9.95, 3.2)]})
        out = _accomp_train_completion(
            [voice], bands, _REV,
            evidence=[(72, 0.2, 1.9)],
        )
        evs = sorted(
            (e.onset_sec, e.offset_sec)
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 41
        )
        pieces = [x for x in evs if x[0] >= 9.0]
        assert pieces[0] == pytest.approx((9.374, 9.85), abs=0.13)
        assert pieces[1][0] == pytest.approx(9.85, abs=0.13)
        assert pieces[1][1] == pytest.approx(10.328)

    def test_long_event_without_attack_not_split(self) -> None:
        # The same 2-slot span with a flat envelope is a real held
        # note — no neighbor thump, no split.
        voice = self._voice(
            self._ev(41.0, 1.892, 2.346, 1),
            self._ev(41.0, 2.346, 2.823, 2),
            self._ev(41.0, 2.823, 3.275, 3),
            self._ev(41.0, 3.275, 3.740, 4),
            self._ev(41.0, 9.374, 10.328, 5),
            self._ev(41.0, 10.328, 10.780, 6),
            self._ev(41.0, 10.780, 11.245, 7),
        )
        bands = self._FakeBands({})
        out = _accomp_train_completion(
            [voice], bands, _REV,
            evidence=[(72, 0.2, 1.9)],
        )
        m41 = sorted(
            e.onset_sec
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 41 and e.onset_sec >= 9.0
        )
        assert m41 == pytest.approx([9.374, 10.328, 10.780])

    def test_holed_train_still_qualifies(self) -> None:
        # #197: the qlm m72 shape — most IOIs are multiples of the
        # true 0.47 s period (the detector kept missing hits), so
        # the old ~1x-only support count read the train as noise
        # and never ran the walk. Multiple-IOI support keeps it a
        # train, and the dead-cover mint fires at the dropped hit.
        # IOIs [0.21, 0.23, 0.46, 0.47, 0.47, 0.48, 0.94, 0.95,
        # 1.41, 1.88] over a 0.475 s median: only 4/10 sit at ~1x
        # (old rule skipped the train); 8/10 are multiples.
        onsets = (0.0, 0.21, 0.44, 0.90, 1.37, 1.84, 2.32, 3.26,
                  4.21, 5.62, 7.50)
        voice = self._voice(*(
            self._ev(72.0, o, o + 0.2, i + 1)
            for i, o in enumerate(onsets)
        ))
        bands = self._FakeBands({72: [(2.7, 2.9, 7.0)]})
        out = _accomp_train_completion(
            [voice],
            bands,
            _REV,
            evidence=[(72, 2.6, 3.0)],
        )
        minted = [
            e for c in out for e in c.events
            if e.source == "train-completion"
        ]
        assert len(minted) == 1
        assert minted[0].onset_sec == pytest.approx(2.8, abs=0.13)

    def test_refined_period_splits_merged_span(self) -> None:
        # #197 (qlm m69): sparse detection medianed the IOI at
        # 0.935 s — twice the true 0.469 s strum grid — so the
        # coarse lattice produced no walk point inside the merged
        # 10.049-10.78 span hiding the e5 strike. The /2 refined
        # lattice reaches it; own-band rise confirms and splits.
        voice = self._voice(
            self._ev(69.0, 0.012, 0.2, 1),
            self._ev(69.0, 0.94, 1.1, 2),
            self._ev(69.0, 2.114, 2.3, 3),
            self._ev(69.0, 2.579, 2.75, 4),
            self._ev(69.0, 3.055, 3.25, 5),
            self._ev(69.0, 3.531, 3.7, 6),
            self._ev(69.0, 7.504, 7.7, 7),
            self._ev(69.0, 8.446, 8.6, 8),
            self._ev(69.0, 9.618, 9.8, 9),
            self._ev(69.0, 10.049, 10.78, 10),
            self._ev(69.0, 11.024, 11.2, 11),
        )
        bands = self._FakeBands({69: [(10.45, 10.65, 7.5)]})
        out = _accomp_train_completion([voice], bands, _REV)
        m69 = sorted(
            e.onset_sec
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 69
        )
        # The merged span split near the real strike (~10.55).
        assert any(abs(o - 10.55) < 0.13 for o in m69)
        assert any(abs(o - 10.049) < 0.01 for o in m69)

    def test_refined_train_ignores_neighbor_thump(self) -> None:
        # #197: on a refined (halved) lattice the midpoints land on
        # OTHER chord members' strike times — the neighbor band's
        # thump must not vouch for a split there (qlm m72 @12.19).
        # The dense voice refines to 0.225 s; the interior points
        # show neighbor-band rise only, so nothing may split.
        voice = self._voice(
            self._ev(60.0, 0.0, 0.2, 1),
            self._ev(60.0, 0.45, 0.65, 2),
            self._ev(60.0, 0.9, 1.1, 3),
            self._ev(60.0, 1.35, 1.55, 4),
            self._ev(60.0, 1.8, 2.0, 5),
            self._ev(60.0, 3.6, 3.8, 6),
            self._ev(60.0, 3.8, 4.0, 7),
            self._ev(60.0, 5.0, 5.9, 8),   # long living span
            self._ev(60.0, 6.3, 6.5, 9),
        )
        # Neighbor (m62) rises only where a refined-only midpoint
        # sits (its argmax window is ~5.10-5.35); own band stays
        # flat, and the base lattice points see no evidence at all.
        bands = self._FakeBands({62: [(5.15, 5.30, 6.0)]})
        out = _accomp_train_completion([voice], bands, _REV)
        m60 = sorted(
            (e.onset_sec, e.offset_sec)
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 60 and e.onset_sec >= 4.9
        )
        assert m60 == pytest.approx([(5.0, 5.9), (6.3, 6.5)])

    def _refined_m72_voice(self, span_end: float) -> CleanedEvents:
        # #197: the qlm m72 detection shape — a ~0.453 s strum grid
        # plus one 0.232 s flicker pair, which refines the lattice to
        # 0.2265 s. The long span covers several lattice slots.
        return self._voice(
            self._ev(72.0, 3.985, 4.217, 1),
            self._ev(72.0, 4.461, 4.681, 2),
            self._ev(72.0, 4.914, span_end, 3),
            self._ev(72.0, 7.748, 7.958, 4),
            self._ev(72.0, 8.213, 8.434, 5),
            self._ev(72.0, 11.5, 11.7, 6),
            self._ev(72.0, 11.732, 11.9, 7),
        )

    def test_refined_point_edge_argmax_rejected(self) -> None:
        # #197: a refined-only lattice point (pos ~5.14) whose argmax
        # lands at the window's far left edge is claiming the
        # PREVIOUS attack's rise tail, not a strike of its own —
        # >half the refined period off the proposal, so no cut.
        bands = self._FakeBands({72: [(5.02, 5.03, 6.0)]})
        voice = self._refined_m72_voice(5.45)
        out = _accomp_train_completion([voice], bands, _REV)
        m72 = sorted(
            (e.onset_sec, e.offset_sec)
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 72
        )
        assert (4.914, 5.45) in [
            (round(o, 3), round(e, 3)) for o, e in m72
        ]
        assert not any(
            e.source == "train-completion"
            for c in out for e in c.events
        )

    def test_close_double_cut_on_one_span_rejected(self) -> None:
        # #197: two adjacent lattice points argmaxing the same
        # attack must not cut twice — the 18 ms sliver between
        # 5.455/5.473 on qlm m72. The first cut stands; the second
        # lands <0.1 s from it and is refused.
        bands = self._FakeBands(
            {72: [(5.44, 5.47, 6.0), (5.50, 5.53, 6.0)]}
        )
        voice = self._refined_m72_voice(5.622)
        out = _accomp_train_completion([voice], bands, _REV)
        minted = sorted(
            (e.onset_sec, e.offset_sec)
            for c in out for e in c.events
            if int(round(e.pitch_midi)) == 72
            and e.source == "train-completion"
        )
        # Exactly one cut survives (~5.447 s from the first rise
        # window); the second rise at ~5.51 sits 66 ms after it.
        assert len(minted) == 1
        assert minted[0][0] == pytest.approx(5.447, abs=0.021)
        assert minted[0][1] == pytest.approx(5.622, abs=0.001)


class TestAccompPadCompletion:
    """#136: sustained pads the attack detector never emits are mined
    from the stem spectrum — deduped against existing detections."""

    def _stem(self, sr: int = 22050) -> Any:
        np = pytest.importorskip("numpy")
        dur = 1.6
        t = np.arange(int(dur * sr)) / sr
        y = np.zeros_like(t)
        # A held pad triad — exactly what Basic Pitch fades under a
        # mix: long sustain, no percussive edge.
        for m in (53, 57, 60):
            f = 440.0 * 2 ** ((m - 69) / 12)
            y += 0.15 * np.sin(2 * np.pi * f * t)
        # Bass quarters the detector already covers — each is too
        # short to mine anyway (0.35 s < the sustain floor), so the
        # dedupe path is belt-and-suspenders here.
        f = 440.0 * 2 ** ((45 - 69) / 12)
        for q in range(4):
            s = int(q * 0.4 * sr)
            e = int((q * 0.4 + 0.35) * sr)
            y[s:e] += 0.25 * np.sin(2 * np.pi * f * t[s:e])
        return y

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-b{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            velocity=80,
            source="test",
        )

    def test_sustained_triad_emitted(self) -> None:
        pytest.importorskip("librosa")
        y = self._stem()
        existing = tuple(
            self._ev(45.0, q * 0.4, q * 0.4 + 0.35, q) for q in range(4)
        )
        out = _accomp_pad_completion(y, 22050, existing, _REV)
        pitches = {int(round(e.pitch_midi)) for e in out}
        assert {53, 57, 60} <= pitches

    def test_silence_emits_nothing(self) -> None:
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        y = np.zeros(22050)
        assert _accomp_pad_completion(y, 22050, (), _REV) == ()

    def test_no_samples_emits_nothing(self) -> None:
        assert _accomp_pad_completion(None, 0, (), _REV) == ()

    def test_held_member_splits_at_chord_restrike(self) -> None:
        # A pad member whose band runs straight through a chord
        # re-strike must notate the repeated hit: two sibling pad
        # bands starting together mark the re-strike, so the held
        # member's span splits there instead of reading as one tie.
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(3.0 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((57 - 69) / 12)
        y += 0.2 * np.sin(2 * np.pi * f * t)
        # Sibling members sound only after the re-strike — their
        # shared run start is the chord onset.
        for m in (60, 64):
            f2 = 440.0 * 2 ** ((m - 69) / 12)
            seg = t >= 1.0
            y[seg] += 0.2 * np.sin(2 * np.pi * f2 * t[seg])
        out = _accomp_pad_completion(y, sr, (), _REV)
        m57 = sorted(
            (e.onset_sec, e.offset_sec)
            for e in out
            if int(round(e.pitch_midi)) == 57
        )
        assert len(m57) == 2
        assert m57[0][0] == pytest.approx(0.0, abs=0.1)
        assert m57[1][0] == pytest.approx(1.0, abs=0.15)
        assert m57[0][1] == pytest.approx(m57[1][0], abs=0.05)

    def test_eighth_note_ostinato_splits_each_strike(self) -> None:
        """#171: a pad restruck every ~0.23 s (eighths at 128 BPM)
        fragments every member band on each hit. The fixed 0.3 s
        margin refused every cut; the fragment-level onsets plus the
        spacing-adaptive margin must notate each strike."""
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        from hornscribe.transcription.pipeline import _accomp_band_evidence

        sr = 22050
        strike = 0.234
        n_strikes = 8
        dur = strike * n_strikes + 0.4
        t = np.arange(int(dur * sr)) / sr
        y = np.zeros_like(t)
        for m in (53, 57, 60):
            f = 440.0 * 2 ** ((m - 69) / 12)
            for k in range(n_strikes):
                s = k * strike
                e = s + strike - 0.028
                seg = (t >= s) & (t < e)
                y[seg] += 0.18 * np.sin(2 * np.pi * f * t[seg])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        out = _accomp_pad_completion(
            y, sr, (), _REV, band_evidence=bands
        )
        m57 = sorted(
            e.onset_sec for e in out
            if int(round(e.pitch_midi)) == 57
        )
        # Each of the 8 strikes should surface as its own note —
        # before #171 the merged run stayed one long span.
        assert len(m57) >= n_strikes - 1

    def test_ostinato_does_not_split_sustained_stranger(self) -> None:
        """#171 safety: a tone held through an ostinato it does NOT
        belong to keeps its span — the member-set filter requires >=2
        accepted pad midis to share the onset."""
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        from hornscribe.transcription.pipeline import _accomp_band_evidence

        sr = 22050
        strike = 0.234
        n_strikes = 8
        dur = strike * n_strikes + 0.4
        t = np.arange(int(dur * sr)) / sr
        y = np.zeros_like(t)
        # Stranger: one continuous pad tone that never dips.
        f = 440.0 * 2 ** ((69 - 69) / 12)
        y += 0.18 * np.sin(2 * np.pi * f * t)
        # Ostinato pair re-striking together every eighth.
        for m in (53, 60):
            f = 440.0 * 2 ** ((m - 69) / 12)
            for k in range(n_strikes):
                s = k * strike
                e = s + strike - 0.028
                seg = (t >= s) & (t < e)
                y[seg] += 0.18 * np.sin(2 * np.pi * f * t[seg])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        out = _accomp_pad_completion(
            y, sr, (), _REV, band_evidence=bands
        )
        m69 = sorted(
            (e.onset_sec, e.offset_sec) for e in out
            if int(round(e.pitch_midi)) == 69
        )
        # The stranger's run is one continuous tone — at most one
        # mined event; the ostinato's onsets must not slice it.
        assert len(m69) <= 2

    def test_fragment_onset_rejected_after_census_collapse(
        self,
    ) -> None:
        """#171 safety: aligned band restarts after a whole-census
        collapse are the vocal mask recovering, not a re-strike — no
        fragment-level onset may be minted there."""
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        from hornscribe.transcription.pipeline import _accomp_band_evidence

        sr = 22050
        dur = 3.0
        t = np.arange(int(dur * sr)) / sr
        y = np.zeros_like(t)
        # Six bands (dense texture) ringing, silenced mid-piece by a
        # hard drop then all restarting together — mask recovery.
        for m in (48, 53, 57, 60, 64, 67):
            f = 440.0 * 2 ** ((m - 69) / 12)
            seg = (t < 1.0) | (t >= 1.35)
            y[seg] += 0.15 * np.sin(2 * np.pi * f * t[seg])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        # The restart at ~1.35 s follows a census collapse and must
        # NOT register as a chord onset for pad splitting purposes.
        near_restart = [
            t0 for t0 in bands._chord_onsets if 1.2 < t0 < 1.6
        ]
        assert near_restart == []

    def test_straggler_strike_members_fuse_into_one_onset(self) -> None:
        """#177: one strike whose member bands peak >cluster-window
        apart minted two flux onsets ~150 ms apart — the fuse pass
        collapses them, unions the members, and keeps the larger
        cluster's measured time."""
        from hornscribe.transcription.pipeline import _fuse_flux_events

        events = [
            (1.0, frozenset({55, 60, 64}), "flux"),
            (1.155, frozenset({55, 60}), "flux"),
        ]
        out = _fuse_flux_events(events)
        assert out == [(1.0, frozenset({55, 60, 64}), "flux")]

    def test_fuse_prefers_richer_cluster_time(self) -> None:
        from hornscribe.transcription.pipeline import _fuse_flux_events

        events = [
            (1.0, frozenset({55, 60}), "flux"),
            (1.15, frozenset({55, 60, 64}), "flux"),
        ]
        out = _fuse_flux_events(events)
        assert out == [(1.15, frozenset({55, 60, 64}), "flux")]

    def test_unrelated_flux_neighbours_stay_separate(self) -> None:
        """#177 safety: flux onsets sharing no member band are two
        strikes even this close — no fuse."""
        from hornscribe.transcription.pipeline import _fuse_flux_events

        events = [
            (1.0, frozenset({55, 60}), "flux"),
            (1.15, frozenset({53, 57}), "flux"),
        ]
        assert len(_fuse_flux_events(events)) == 2

    def test_strong_neighbour_never_fuses_into_flux(self) -> None:
        """#177 safety: a strong-tier onset beside a flux one is a
        real adjacent articulation, not a straggler."""
        from hornscribe.transcription.pipeline import _fuse_flux_events

        events = [
            (1.0, frozenset({55, 60}), "strong"),
            (1.1, frozenset({55, 60}), "flux"),
        ]
        assert len(_fuse_flux_events(events)) == 2


class TestHotRunBridge:
    """#179: short release dips inside the pad-mining walk bridge so a
    restruck member's flickering mask still forms its run."""

    def _spans(self, mask, hole=0):
        np = pytest.importorskip("numpy")
        from hornscribe.transcription.pipeline import _hot_run_spans

        h = [np.asarray(mask, dtype=bool)]
        e = [np.ones(len(mask), dtype=float)]
        t = np.arange(len(mask), dtype=float) * 0.0232
        return _hot_run_spans((60,), e, h, t, 0.1, hole_frames=hole)

    def test_short_gap_bridges_into_one_run(self) -> None:
        # hot 10f - cold 2f - hot 10f: a ~46 ms release dip.
        mask = [True] * 10 + [False] * 2 + [True] * 10
        out = self._spans(mask, hole=4)
        assert len(out) == 1
        assert out[0][0] == pytest.approx(0.0)
        assert out[0][1] == pytest.approx(21 * 0.0232, abs=0.001)

    def test_unbridged_walk_keeps_fragments(self) -> None:
        mask = [True] * 10 + [False] * 2 + [True] * 10
        assert len(self._spans(mask, hole=0)) == 2

    def test_real_release_breaks_the_run(self) -> None:
        # cold 6f (~139 ms) exceeds the 4-frame hole budget — a real
        # rest, not a strike dip.
        mask = [True] * 10 + [False] * 6 + [True] * 10
        assert len(self._spans(mask, hole=4)) == 2

    def test_trailing_cold_does_not_extend(self) -> None:
        # The run must still end where the band actually released —
        # a hole bridges interior gaps only.
        mask = [True] * 10 + [False] * 2 + [False] * 10
        out = self._spans(mask, hole=4)
        assert len(out) == 1
        assert out[0][1] == pytest.approx(10 * 0.0232, abs=0.001)


class TestLatticeFlux:
    """#177: strict events anchor a strike grid; interior grid
    points join on the softer support signature."""

    def _bands(self):
        np = pytest.importorskip("numpy")
        from hornscribe.transcription.pipeline import _AccompBands

        b = _AccompBands.__new__(_AccompBands)
        b._spf = 0.0232
        b._n_hot = np.full(2000, 8)  # healthy census — no dead span
        return b

    def test_interior_grid_point_mints_event(self) -> None:
        b = self._bands()
        hard = [(0.234, 57), (0.468, 57)]
        support = [
            (0.234, 53), (0.234, 57), (0.234, 60), (0.468, 57),
        ]
        events = [
            (0.0, frozenset({53, 57}), "strong"),
            (0.468, frozenset({53, 57}), "flux"),
        ]
        out = b._lattice_flux(hard, support, events)
        assert [round(t, 3) for t, _m, _k in out] == [0.234]
        assert out[0][1] == frozenset({53, 57, 60})
        assert out[0][2] == "flux"

    def test_strong_to_strong_gap_never_subdivides(self) -> None:
        """#177 safety: a held-chord span (strong anchors only) is a
        chord change, not a strike train — no grid is invented."""
        b = self._bands()
        hard = [(0.234, 57)]
        support = [(0.234, 53), (0.234, 57), (0.234, 60)]
        events = [
            (0.0, frozenset({53, 57}), "strong"),
            (0.468, frozenset({53, 57}), "strong"),
        ]
        assert b._lattice_flux(hard, support, events) == []

    def test_sparse_coverage_mints_nothing(self) -> None:
        """#177 safety: one lucky support cluster inside a long gap
        is not a grid — coverage below the threshold refuses the
        whole subdivision."""
        b = self._bands()
        hard = [(0.234, 57)]
        support = [(0.234, 53), (0.234, 57), (0.234, 60)]
        events = [
            (0.0, frozenset({53, 57}), "flux"),
            (0.936, frozenset({53, 57}), "flux"),
        ]
        assert b._lattice_flux(hard, support, events) == []

    def test_jitter_without_hard_peak_mints_nothing(self) -> None:
        """#177 safety: >=3 soft members still need >=1 hard peak —
        held-chord jitter bands alone cannot mint a grid point."""
        b = self._bands()
        support = [(0.234, 53), (0.234, 57), (0.234, 60)]
        events = [
            (0.0, frozenset({53, 57}), "flux"),
            (0.468, frozenset({53, 57}), "flux"),
        ]
        assert b._lattice_flux([], support, events) == []

    def test_existing_onset_suppresses_duplicate(self) -> None:
        """A grid point already carrying an event mints nothing —
        the lattice fills gaps, it does not double them."""
        b = self._bands()
        hard = [(0.234, 57)]
        support = [(0.234, 53), (0.234, 57), (0.234, 60)]
        events = [
            (0.0, frozenset({53, 57}), "flux"),
            (0.234, frozenset({53, 57}), "flux"),
            (0.468, frozenset({53, 57}), "flux"),
        ]
        assert b._lattice_flux(hard, support, events) == []


class TestExpandFluxMembers:
    """#181: a member whose rise lands just under the hard flux bar
    still re-attacked — the member set decides which held runs a
    flux onset may cut, so membership grows to every band carrying
    a support-level peak at the strike."""

    def test_soft_member_joins_flux_event(self) -> None:
        from hornscribe.transcription.pipeline import _expand_flux_members

        events = [(1.0, frozenset({55, 60}), "flux")]
        support = [(0.99, 55), (1.0, 60), (1.02, 64)]
        out = _expand_flux_members(events, support)
        assert out == [(1.0, frozenset({55, 60, 64}), "flux")]

    def test_strong_event_keeps_its_measured_members(self) -> None:
        """A strong-tier onset cuts every held run regardless — its
        member set stays the strict measurement, not the soft
        signature."""
        from hornscribe.transcription.pipeline import _expand_flux_members

        events = [(1.0, frozenset({55, 60}), "strong")]
        support = [(1.0, 55), (1.0, 60), (1.0, 64)]
        out = _expand_flux_members(events, support)
        assert out == [(1.0, frozenset({55, 60}), "strong")]

    def test_peak_outside_align_window_does_not_join(self) -> None:
        """A rise past the lattice align window belongs to another
        strike — it must not ride on this onset's member set."""
        from hornscribe.transcription.pipeline import (
            _ACCOMP_PAD_LATTICE_ALIGN_SEC,
            _expand_flux_members,
        )

        events = [(1.0, frozenset({55}), "flux")]
        support = [(1.0 + _ACCOMP_PAD_LATTICE_ALIGN_SEC + 0.01, 64)]
        out = _expand_flux_members(events, support)
        assert out == [(1.0, frozenset({55}), "flux")]

    def test_empty_support_keeps_events_untouched(self) -> None:
        from hornscribe.transcription.pipeline import _expand_flux_members

        events = [(1.0, frozenset({55, 60}), "flux")]
        assert _expand_flux_members(events, []) == events


class TestTailFlux:
    """#187: the lattice only mints interior grid points, so a strike
    train reaching the analysis end dies one anchor short — the tail
    walk extends the measured step while each predicted point still
    carries a support cluster."""

    def _bands(self):
        np = pytest.importorskip("numpy")
        from hornscribe.transcription.pipeline import _AccompBands

        b = _AccompBands.__new__(_AccompBands)
        b._spf = 0.0232
        b._frames = 700
        b._n_hot = np.full(2000, 8)  # healthy census — no dead span
        return b

    def test_supported_step_mints_one_tail_event(self) -> None:
        b = self._bands()
        hard = [(0.744, 59)]
        support = [(0.744, 55), (0.745, 59), (0.768, 62)]
        events = [
            (0.280, frozenset({55, 59, 62}), "flux"),
            (0.512, frozenset({55, 59, 62}), "flux"),
        ]
        out = b._tail_flux(hard, support, events)
        assert [round(t, 3) for t, _m, _k in out] == [0.744]
        assert out[0][1] == frozenset({55, 59, 62})
        assert out[0][2] == "flux"

    def test_walk_continues_while_support_continues(self) -> None:
        b = self._bands()
        hard = [(0.744, 59), (0.976, 59)]
        support = [
            (0.744, 55), (0.744, 59), (0.768, 62),
            (0.976, 55), (0.976, 59), (0.976, 62),
        ]
        events = [
            (0.280, frozenset({55, 59, 62}), "flux"),
            (0.512, frozenset({55, 59, 62}), "flux"),
        ]
        out = b._tail_flux(hard, support, events)
        assert [round(t, 3) for t, _m, _k in out] == [0.744, 0.976]

    def test_strong_last_anchor_never_extends(self) -> None:
        """#187 safety: a held-chord ending (strong anchors only) is
        not a strike train — the walk needs a flux anchor."""
        b = self._bands()
        hard = [(0.744, 59)]
        support = [(0.744, 55), (0.744, 59), (0.768, 62)]
        events = [
            (0.280, frozenset({55, 59, 62}), "strong"),
            (0.512, frozenset({55, 59, 62}), "strong"),
        ]
        assert b._tail_flux(hard, support, events) == []

    def test_no_hard_member_mints_nothing(self) -> None:
        """#187 safety: >=3 soft members still need >=1 hard peak —
        jitter alone cannot extend the grid."""
        b = self._bands()
        support = [(0.744, 55), (0.744, 59), (0.768, 62)]
        events = [
            (0.280, frozenset({55, 59, 62}), "flux"),
            (0.512, frozenset({55, 59, 62}), "flux"),
        ]
        assert b._tail_flux([], support, events) == []

    def test_first_uncovered_step_stops_the_walk(self) -> None:
        b = self._bands()
        hard = [(0.744, 59)]
        support = [(0.744, 55), (0.744, 59), (0.768, 62)]
        events = [
            (0.280, frozenset({55, 59, 62}), "flux"),
            (0.512, frozenset({55, 59, 62}), "flux"),
        ]
        out = b._tail_flux(hard, support, events)
        assert len(out) == 1  # 0.976 has no support — walk stops


class TestPadEventVoices:
    """#169: mined pad events must quantize per pitch — a single blob
    reads as one monophonic voice and the quantizer staggers chord
    members into adjacent grid slots."""

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-v{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=None,
            velocity=None,
            source="pad-completion",
        )

    def test_chord_members_split_into_per_pitch_voices(self) -> None:
        pad = (
            self._ev(57.0, 0.0, 1.86, 1),
            self._ev(53.0, 0.0, 1.86, 2),
            self._ev(60.0, 0.0, 1.86, 3),
        )
        voices = _pad_event_voices(pad)
        assert len(voices) == 3
        for v in voices:
            assert len({int(round(e.pitch_midi)) for e in v.events}) == 1

    def test_sequential_same_pitch_stays_one_voice(self) -> None:
        pad = (
            self._ev(57.0, 0.0, 1.0, 1),
            self._ev(57.0, 1.86, 3.0, 2),
            self._ev(60.0, 0.0, 3.0, 3),
        )
        voices = _pad_event_voices(pad)
        assert len(voices) == 2
        v57 = next(
            v for v in voices
            if int(round(v.events[0].pitch_midi)) == 57
        )
        assert [e.onset_sec for e in v57.events] == [0.0, 1.86]

    def test_empty(self) -> None:
        assert _pad_event_voices(()) == []


class TestAccompSeamHeal:
    """#160: a same-pitch neighbour pair merges only when the stem's
    per-midi band energy stays elevated across the seam — broadband
    onsets (drums) must not veto the heal, and a real re-attack (the
    band dips through the seam) must not merge."""

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-s{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            velocity=80,
            source="test",
        )

    def test_none_verdict_passthrough(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.4, 1), self._ev(60.0, 0.4, 0.8, 2))
        out, n = _heal_accomp_fragments(ev, None)
        assert n == 0 and len(out) == 2

    def test_continuity_merges_adjacent(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.4, 1), self._ev(60.0, 0.44, 0.9, 2))
        out, n = _heal_accomp_fragments(ev, lambda a, b: False)
        assert n == 1
        assert len(out) == 1
        assert out[0].offset_sec == pytest.approx(0.9)

    def test_dipped_band_keeps_separate(self) -> None:
        ev = (self._ev(45.0, 0.0, 0.4, 1), self._ev(45.0, 0.44, 0.9, 2))
        out, n = _heal_accomp_fragments(ev, lambda a, b: True)
        assert n == 0 and len(out) == 2

    def test_chain_folds_transitively(self) -> None:
        ev = (
            self._ev(57.0, 0.0, 0.3, 1),
            self._ev(57.0, 0.3, 0.6, 2),
            self._ev(57.0, 0.62, 0.9, 3),
        )
        out, n = _heal_accomp_fragments(ev, lambda a, b: False)
        assert n == 2 and len(out) == 1
        assert out[0].offset_sec == pytest.approx(0.9)

    def test_wide_gap_never_merges(self) -> None:
        # A >120 ms silence is a real rest — not a detector split.
        ev = (self._ev(60.0, 0.0, 0.3, 1), self._ev(60.0, 0.5, 0.9, 2))
        out, n = _heal_accomp_fragments(ev, lambda a, b: False)
        assert n == 0 and len(out) == 2

    def test_different_pitch_untouched(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.4, 1), self._ev(64.0, 0.4, 0.8, 2))
        out, n = _heal_accomp_fragments(ev, lambda a, b: False)
        assert n == 0 and len(out) == 2

    def test_interleaved_other_pitch_blocks_chain(self) -> None:
        # A lower/higher fragment between the same-pitch pair is real
        # content — only directly adjacent neighbours may merge.
        ev = (
            self._ev(60.0, 0.0, 0.4, 1),
            self._ev(64.0, 0.4, 0.5, 2),
            self._ev(60.0, 0.5, 0.9, 3),
        )
        out, n = _heal_accomp_fragments(ev, lambda a, b: False)
        assert n == 0 and len(out) == 3


class TestAccompBandVerdict:
    """#160: pitch-specific seam evidence on the accompaniment stem —
    sustained tone -> merge, released+reattacked tone -> keep."""

    def _tone(self, midi: int, sr: int = 22050, gap_sec: float = 0.0) -> Any:
        np = pytest.importorskip("numpy")
        f = 440.0 * 2 ** ((midi - 69) / 12)
        t = np.arange(int(2.0 * sr)) / sr
        y = np.zeros_like(t)
        # note a: [0.2, 0.9), note b: [0.9+gap, 1.7)
        a = (t >= 0.2) & (t < 0.9)
        b = (t >= 0.9 + gap_sec) & (t < 1.7)
        y[a] += 0.2 * np.sin(2 * np.pi * f * t[a])
        y[b] += 0.2 * np.sin(2 * np.pi * f * t[b])
        return y

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-v{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            source="test",
        )

    def test_sustained_tone_seam_not_separated(self) -> None:
        pytest.importorskip("librosa")
        y = self._tone(57)  # continuous 0.2-1.7 except the split label
        verdict = _accomp_band_verdict(y, 22050)
        assert verdict is not None
        a = self._ev(57.0, 0.2, 0.9, 1)
        b = self._ev(57.0, 0.9, 1.7, 2)
        assert verdict(a, b) is False

    def test_reattack_with_silence_separated(self) -> None:
        pytest.importorskip("librosa")
        y = self._tone(45, gap_sec=0.10)  # real 100 ms release gap
        verdict = _accomp_band_verdict(y, 22050)
        assert verdict is not None
        a = self._ev(45.0, 0.2, 0.9, 1)
        b = self._ev(45.0, 1.0, 1.7, 2)
        assert verdict(a, b) is True

    def test_unavailable_audio_returns_none(self) -> None:
        assert _accomp_band_verdict(None, 0) is None

    def test_selection_offset_maps_to_stem_axis(self) -> None:
        # Job times sit at +3.0 s against the stem's own axis — the
        # verdict must subtract the offset before indexing frames.
        pytest.importorskip("librosa")
        y = self._tone(57)
        verdict = _accomp_band_verdict(y, 22050, time_offset_sec=3.0)
        assert verdict is not None
        a = self._ev(57.0, 3.2, 3.9, 1)
        b = self._ev(57.0, 3.9, 4.7, 2)
        assert verdict(a, b) is False


class TestFoldAccompSlivers:
    """#155: a sub-90 ms event wedged gap-free between same-pitch
    neighbours is detector boundary noise — fold it into the
    predecessor rather than printing a phantom 32nd."""

    def _ev(
        self,
        midi: float,
        onset: float,
        offset: float,
        i: int,
        conf: float | None = 0.8,
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-f{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=conf,
            source="test",
        )

    def test_sandwiched_sliver_folds(self) -> None:
        ev = (
            self._ev(45.0, 7.504, 7.899, 1),
            self._ev(45.0, 7.899, 7.970, 2),  # 71 ms boundary sliver
            self._ev(45.0, 7.970, 8.364, 3),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 1 and len(out) == 2
        assert out[0].offset_sec == pytest.approx(7.970)
        assert out[1].onset_sec == pytest.approx(7.970)

    def test_sliver_with_real_gap_kept(self) -> None:
        # A gap on one side means a real articulation happened.
        ev = (
            self._ev(45.0, 0.0, 0.4, 1),
            self._ev(45.0, 0.44, 0.50, 2),
            self._ev(45.0, 0.50, 0.9, 3),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3

    def test_long_note_never_a_sliver(self) -> None:
        ev = (
            self._ev(45.0, 0.0, 0.4, 1),
            self._ev(45.0, 0.4, 0.7, 2),  # 300 ms — a real note
            self._ev(45.0, 0.7, 0.9, 3),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3

    def test_different_pitch_neighbours_untouched(self) -> None:
        ev = (
            self._ev(45.0, 0.0, 0.4, 1),
            self._ev(48.0, 0.4, 0.45, 2),
            self._ev(45.0, 0.45, 0.9, 3),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3

    def test_too_short_input_passthrough(self) -> None:
        ev = (self._ev(45.0, 0.0, 0.05, 1), self._ev(45.0, 0.05, 0.5, 2))
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 2

    def test_weak_sliver_below_neighbour_confidence_folds(self) -> None:
        # #195: the 93 ms early false fire on jpop-mix-hard-vocal m45 —
        # above the 90 ms cap but weaker than both real strikes.
        ev = (
            self._ev(45.0, 0.476, 0.859, 1, conf=0.72),
            self._ev(45.0, 0.859, 0.952, 2, conf=0.54),
            self._ev(45.0, 0.952, 1.405, 3, conf=0.67),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 1 and len(out) == 2
        assert out[0].offset_sec == pytest.approx(0.952)
        assert out[1].onset_sec == pytest.approx(0.952)

    def test_weak_sliver_strong_confidence_kept(self) -> None:
        # A sandwiched note in the 90-110 ms band that out-confidences
        # a neighbour is a real articulation — keep it.
        ev = (
            self._ev(45.0, 0.0, 0.4, 1, conf=0.60),
            self._ev(45.0, 0.4, 0.495, 2, conf=0.78),
            self._ev(45.0, 0.495, 0.9, 3, conf=0.62),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3

    def test_weak_sliver_missing_confidence_kept(self) -> None:
        # No confidence to judge by — the weak path stays out and the
        # over-90 ms island survives.
        ev = (
            self._ev(45.0, 0.0, 0.4, 1, conf=0.72),
            self._ev(45.0, 0.4, 0.495, 2, conf=None),
            self._ev(45.0, 0.495, 0.9, 3, conf=0.67),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3

    def test_over_weak_max_never_folds(self) -> None:
        ev = (
            self._ev(45.0, 0.0, 0.4, 1, conf=0.72),
            self._ev(45.0, 0.4, 0.515, 2, conf=0.40),  # 115 ms island
            self._ev(45.0, 0.515, 0.9, 3, conf=0.67),
        )
        out, n = _fold_accomp_slivers(ev)
        assert n == 0 and len(out) == 3


class TestBackdateAccompOnsets:
    """#155: a detection fired mid-sustain is a late onset — the band
    run reaches back to the tone's true start (jpdb: midi-64 pad
    detected 1.3 s late became a false note)."""

    class _FakeBands:
        def __init__(
            self,
            starts: dict[int, float],
            separated: bool = True,
            attack: bool = True,
            reattack: float = 0.0,
        ) -> None:
            self._starts = starts
            self._separated = separated
            self._attack = attack
            self._reattack = reattack

        def run_start(self, midi: float, onset_sec: float) -> float | None:
            return self._starts.get(int(round(midi)))

        def separated(self, a: RawNoteEvent, b: RawNoteEvent) -> bool:
            return self._separated

        def attack_evidence(self, midi: float, onset_sec: float) -> bool:
            return self._attack

        def band_reattack(
            self, midi: float, onset_sec: float
        ) -> float | None:
            return self._reattack

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-d{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            source="test",
        )

    def test_late_onset_backdates_to_run_start(self) -> None:
        # reattack default 0.0: the mid-sustain detection carries no
        # own-band attack at the claimed onset, so the run may pull
        # it back (#197's veto only protects real re-strikes).
        bands = self._FakeBands({64: 3.75})
        ev = (self._ev(64.0, 5.006, 5.541, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert backdated == 1 and merged == 0
        assert out[0].onset_sec == pytest.approx(3.75)
        assert out[0].offset_sec == pytest.approx(5.541)

    def test_small_gain_not_a_backdate(self) -> None:
        # 80 ms of window lead is smear, not a late onset.
        bands = self._FakeBands({60: 0.92})
        ev = (self._ev(60.0, 1.0, 1.5, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert backdated == 0 and out[0].onset_sec == pytest.approx(1.0)

    def test_same_pitch_predecessor_inside_run_merges(self) -> None:
        # The band stayed hot through the gap — one sustained tone the
        # detector re-onset (the >120 ms-gap sibling of the seam heal).
        bands = self._FakeBands({57: 0.2}, separated=False)
        ev = (
            self._ev(57.0, 0.2, 0.9, 1),
            self._ev(57.0, 1.1, 1.7, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 1 and len(out) == 1
        assert out[0].offset_sec == pytest.approx(1.7)

    def test_gap_before_run_start_keeps_real_rest(self) -> None:
        # Band went cold after the predecessor, then rose again — the
        # second note is a real new onset, only backdated to its rise.
        bands = self._FakeBands({57: 1.0})
        ev = (
            self._ev(57.0, 0.2, 0.9, 1),
            self._ev(57.0, 1.3, 1.7, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 0 and len(out) == 2
        # run 1.0 > floor 0.9 and gain 0.3 >= min -> onset moves to 1.0
        assert out[1].onset_sec == pytest.approx(1.0)

    def test_dipped_gap_is_a_reattack_not_a_merge(self) -> None:
        # A 30 ms release dip between same-pitch notes reads as a
        # re-articulation to the seam verdict — the second note keeps
        # its own onset instead of folding into a fake sustained tone.
        bands = self._FakeBands({45: 0.3}, separated=True)
        ev = (
            self._ev(45.0, 0.0, 0.5, 1),
            self._ev(45.0, 0.54, 1.0, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 0 and len(out) == 2
        # run 0.3 < floor 0.5 -> the recovered span is too small to
        # move the onset — the note keeps its detected attack.
        assert out[1].onset_sec == pytest.approx(0.54)

    def test_mask_dip_reonset_folds_into_run(self) -> None:
        # #172: the seam dipped AND the run containing the re-onset
        # reaches back to the predecessor's own onset with no attack
        # evidence there — a mask-recovery refire of a tone that
        # never released, folded into the surviving event.
        bands = self._FakeBands({57: 0.2}, separated=True, attack=False)
        ev = (
            self._ev(57.0, 0.2, 0.9, 1),
            self._ev(57.0, 1.1, 1.7, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 1 and len(out) == 1
        assert out[0].offset_sec == pytest.approx(1.7)

    def test_dipped_gap_with_attack_keeps_reattack(self) -> None:
        # #172: the run also reaches back (short release gaps bridge
        # as holes), but the band posts an attack at the re-onset —
        # a real same-pitch re-strike like a bass quarter — kept.
        bands = self._FakeBands({45: 0.2}, separated=True, attack=True)
        ev = (
            self._ev(45.0, 0.2, 0.6, 1),
            self._ev(45.0, 0.63, 1.1, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 0 and len(out) == 2

    def test_no_evidence_passthrough(self) -> None:
        ev = (self._ev(60.0, 0.0, 0.5, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, None)
        assert backdated == 0 and merged == 0 and len(out) == 1

    def test_pad_completion_events_never_touched(self) -> None:
        bands = self._FakeBands({57: 0.0})
        pad = replace(
            self._ev(57.0, 1.0, 2.0, 1), source="pad-completion"
        )
        out, backdated, merged = _backdate_accomp_onsets((pad,), bands)
        assert backdated == 0 and merged == 0
        assert out[0].onset_sec == pytest.approx(1.0)

    def test_real_stem_late_onset(self) -> None:
        # Sustained tone 0.2-1.7, detection claims onset 1.0 — the
        # band run must pull it back near the true start.
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(2.0 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((57 - 69) / 12)
        m = (t >= 0.2) & (t < 1.7)
        y[m] += 0.2 * np.sin(2 * np.pi * f * t[m])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        ev = (self._ev(57.0, 1.0, 1.6, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert backdated == 1
        assert out[0].onset_sec < 0.45  # ~0.2 minus window smear

    def test_real_stem_cold_onset_not_moved(self) -> None:
        # A genuine attack: the band is cold before the onset — the
        # run starts at the detection, so nothing moves.
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(2.0 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((57 - 69) / 12)
        m = (t >= 1.0) & (t < 1.7)
        y[m] += 0.2 * np.sin(2 * np.pi * f * t[m])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        ev = (self._ev(57.0, 1.05, 1.6, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        # band rises ~1 frame before the true onset (window smear) —
        # far under the 0.18 s floor, so the onset stays put.
        assert backdated == 0 and merged == 0
        assert out[0].onset_sec == pytest.approx(1.05)

    def test_run_start_stops_at_chord_restrike(self) -> None:
        # The band holds straight through a chord re-strike, but the
        # sibling members' shared run start marks the new attack —
        # the walk must stop there, not at the run's older head.
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(2.4 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((57 - 69) / 12)
        y += 0.2 * np.sin(2 * np.pi * f * t)
        for m in (60, 64):
            f2 = 440.0 * 2 ** ((m - 69) / 12)
            seg = t >= 1.0
            y[seg] += 0.2 * np.sin(2 * np.pi * f2 * t[seg])
        bands = _accomp_band_evidence(y, sr)
        assert bands is not None
        ev = (self._ev(57.0, 1.5, 2.0, 1),)
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert backdated == 1 and merged == 0
        assert out[0].onset_sec == pytest.approx(1.0, abs=0.2)

    def test_attack_at_onset_never_backdated(self) -> None:
        # #197: the band's own attack evidence at the reported onset
        # marks an honest re-strike — qlm m72 @11.954 was dragged to
        # the predecessor's offset (11.732) by the floor-clamped run,
        # re-timing it onto the previous chord boundary's bleed and
        # un-nesting it from the containing voice's span.
        # The refire sibling measures ~1.2 own-band rise; an honest
        # strike posts >=4.5 — 4.7 here clears the 3.0 veto bar.
        bands = self._FakeBands(
            {72: 11.238}, separated=True, attack=True, reattack=4.7
        )
        ev = (
            self._ev(72.0, 11.5, 11.732, 1),
            self._ev(72.0, 11.954, 12.175, 2),
        )
        out, backdated, merged = _backdate_accomp_onsets(ev, bands)
        assert merged == 0 and len(out) == 2
        assert backdated == 0
        assert out[1].onset_sec == pytest.approx(11.954)


class TestAccompPadCompletionOffset:
    """#160: pad candidates land on the job timeline — a selection job
    must not emit them selection_offset_sec early, and the coverage
    check must compare against stem-axis detections."""

    def _ev(self, midi: float, onset: float, offset: float, i: int) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-o{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=offset,
            confidence=0.8,
            source="test",
        )

    def test_candidates_shifted_to_job_time(self) -> None:
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(1.6 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((60 - 69) / 12)
        y += 0.2 * np.sin(2 * np.pi * f * t)
        out = _accomp_pad_completion(
            y, sr, (), _REV, time_offset_sec=3.0
        )
        assert out
        assert min(e.onset_sec for e in out) >= 3.0

    def test_coverage_check_uses_stem_axis(self) -> None:
        np = pytest.importorskip("numpy")
        pytest.importorskip("librosa")
        sr = 22050
        t = np.arange(int(1.6 * sr)) / sr
        y = np.zeros_like(t)
        f = 440.0 * 2 ** ((60 - 69) / 12)
        y += 0.2 * np.sin(2 * np.pi * f * t)
        # Job-time existing note covering the whole stem span at the
        # same pitch — with the offset applied it suppresses the pad.
        existing = (self._ev(60.0, 3.0, 4.5, 1),)
        out = _accomp_pad_completion(
            y, sr, existing, _REV, time_offset_sec=3.0
        )
        assert out == ()


class TestMergeBandFragments:
    """#162: the band-merge bridge must span a separation dropout
    (~0.4 s on center-extraction stems) without welding genuinely
    separate bands or different pitches."""

    def test_dropout_gap_merges(self) -> None:
        cands = [(0.0, 1.0, 60, 0.5), (1.4, 3.0, 60, 0.4)]
        out = _merge_band_fragments(cands)
        assert out == [(0.0, 3.0, 60, 0.5)]

    def test_long_gap_stays_split(self) -> None:
        cands = [(0.0, 1.0, 60, 0.5), (1.7, 3.0, 60, 0.4)]
        out = _merge_band_fragments(cands)
        assert out == [(0.0, 1.0, 60, 0.5), (1.7, 3.0, 60, 0.4)]

    def test_other_pitch_never_merges(self) -> None:
        cands = [(0.0, 1.0, 60, 0.5), (1.05, 3.0, 64, 0.4)]
        out = _merge_band_fragments(cands)
        assert len(out) == 2

    def test_explicit_gap_overrides_default(self) -> None:
        cands = [(0.0, 1.0, 60, 0.5), (1.4, 3.0, 60, 0.4)]
        out = _merge_band_fragments(cands, gap_sec=0.15)
        assert len(out) == 2


class TestAccompDetectedEvents:
    """#162: meter channels and pickup phase evidence drink from the
    accompaniment accent pool, so mined pad-completion onsets (band
    threshold crossings, not articulations) must not reach it."""

    def _ev(
        self, midi: float, onset: float, i: int, source: str | None
    ) -> RawNoteEvent:
        return RawNoteEvent(
            id=RawNoteEventId(f"rne-d{i:06d}"),
            transcription_revision=_REV,
            pitch_midi=midi,
            onset_sec=onset,
            offset_sec=onset + 0.4,
            confidence=0.8,
            velocity=80,
            source=source,
        )

    def _cleaned(self, events: tuple[RawNoteEvent, ...]) -> CleanedEvents:
        return CleanedEvents(
            events=events,
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )

    def test_mined_onsets_excluded(self) -> None:
        detected = (
            self._ev(45.0, 0.0, 0, "basic-pitch"),
            self._ev(52.0, 0.5, 1, "pyin"),
            self._ev(57.0, 1.0, 2, None),
        )
        mined = tuple(
            self._ev(60.0, 0.25 + 0.5 * i, 10 + i, "pad-completion")
            for i in range(6)
        )
        cleaned = [self._cleaned(detected), self._cleaned(mined)]
        out = list(_accomp_detected_events(cleaned))
        assert [e.pitch_midi for e in out] == [45.0, 52.0, 57.0]
        assert all(e.source != "pad-completion" for e in out)

    def test_empty_yields_nothing(self) -> None:
        assert list(_accomp_detected_events(())) == []
