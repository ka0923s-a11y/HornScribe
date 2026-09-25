"""#358: pickup-inference uncertainty — reviewable evidence.

The auto-estimated anacrusis is a heuristic over the first-onset /
beat-0 gap plus the accent phase of the tracked beats. When the
evidence cannot justify the inference the pipeline emits a
``pickup_uncertain`` ReviewIssue instead of writing the guess
silently — these tests pin the flag matrix and the suggestion
the review bar turns into a ``setPickup`` edit."""

from __future__ import annotations

from fractions import Fraction

from hornscribe.rhythm.meter import MeterSegment
from hornscribe.transcription.tempo import (
    TempoEstimate,
    estimate_tempo,
    pickup_uncertainty,
)

# 12 quarter beats at 120 BPM — plenty of measures for phase scoring.
BEATS_120 = tuple(i * 0.5 for i in range(12))


def _estimate(
    beat_times: tuple[float, ...],
    *,
    first_onset_sec: float | None,
    beat_strengths: tuple[float, ...] | None = None,
    tempo_bpm: float | None = None,
    pulse_unit_ql: Fraction | None = None,
    numerator: int = 4,
    denominator: int = 4,
) -> TempoEstimate:
    return estimate_tempo(
        samples=None,
        sample_rate=22050,
        meter=MeterSegment(
            start_ql=Fraction(0),
            numerator=numerator,
            denominator=denominator,
        ),
        tempo_bpm=tempo_bpm,
        first_onset_sec=first_onset_sec,
        beat_times=beat_times,
        pulse_unit_ql=pulse_unit_ql,
        beat_strengths=beat_strengths,
    )


def _downbeat_strengths(phase: int, n: int = 12) -> tuple[float, ...]:
    """Accents at every beat index ``i % 4 == phase`` (4/4 grid)."""
    return tuple(0.9 if i % 4 == phase else 0.2 for i in range(n))


class TestConfidentInference:
    """Evidence agrees with the written grid -> no issue."""

    def test_on_grid_onset_with_downbeat_accents_stays_silent(
        self,
    ) -> None:
        est = _estimate(
            BEATS_120,
            first_onset_sec=0.0,
            beat_strengths=_downbeat_strengths(0),
        )
        assert est.pickup_len_ql == 0
        a = est.pickup_analysis
        assert a is not None
        assert a.inferred_pickup_beats == 0
        assert a.onset_phase_in_beat == 0.0
        assert pickup_uncertainty(est) is None

    def test_no_strengths_on_grid_stays_silent(self) -> None:
        # Without accent evidence the phase candidates cannot be
        # ranked — and an onset exactly on beat 0 leaves nothing
        # else to doubt.
        est = _estimate(BEATS_120, first_onset_sec=0.0)
        a = est.pickup_analysis
        assert a is not None
        assert a.strength_available is False
        assert pickup_uncertainty(est) is None

    def test_pinned_tempo_carries_no_analysis(self) -> None:
        # A user-set tempo never guessed a pickup — nothing to flag.
        est = _estimate(
            BEATS_120, first_onset_sec=0.0, tempo_bpm=120.0
        )
        assert est.pickup_analysis is None
        assert pickup_uncertainty(est) is None

    def test_tracking_fallback_carries_no_analysis(self) -> None:
        est = _estimate((0.0,), first_onset_sec=0.0)
        assert est.pickup_analysis is None
        assert pickup_uncertainty(est) is None


class TestAmbiguousInference:
    """Each ambiguity flag -> a ReviewIssue evidence dict."""

    def test_hairline_onset_suggests_no_pickup(self) -> None:
        # The classic phantom anacrusis: onset 10 ms before beat 0
        # forced a whole-beat lift — tracker jitter is just as
        # plausible, so the fix suggestion is 弱起なし.
        est = _estimate(
            BEATS_120,
            first_onset_sec=-0.01,
            beat_strengths=_downbeat_strengths(0),
        )
        assert est.pickup_len_ql == Fraction(1)
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert ev["inferredPickupBeats"] == 1
        assert ev["flags"] == ["hairline_onset"]
        assert ev["suggestedPickupBeats"] == 0

    def test_accent_phase_mismatch_suggests_alternative(self) -> None:
        # Beat 0 was written as the downbeat but the energy clearly
        # lives one tracked beat later — a one-beat pickup is the
        # better reading.
        est = _estimate(
            BEATS_120,
            first_onset_sec=0.0,
            beat_strengths=_downbeat_strengths(1),
        )
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert ev["flags"] == ["downbeat_phase_mismatch"]
        assert ev["suggestedPickupBeats"] == 1

    def test_near_tied_phases_report_without_suggestion(self) -> None:
        # Two phase candidates inside the margin — flag for review
        # but offer no auto-fix (the evidence cannot pick a winner).
        strengths = (0.85, 0.8, 0.2, 0.1) * 3
        est = _estimate(
            BEATS_120,
            first_onset_sec=0.0,
            beat_strengths=strengths,
        )
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert ev["flags"] == ["downbeat_phase_ambiguous"]
        assert ev["suggestedPickupBeats"] is None

    def test_offbeat_first_onset_flags_mid_beat(self) -> None:
        # Onset lands half a beat into the cell: a syncopated
        # entrance and an offbeat anacrusis read identically.
        est = _estimate(BEATS_120, first_onset_sec=0.25)
        a = est.pickup_analysis
        assert a is not None
        assert a.onset_phase_in_beat == 0.5
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert ev["flags"] == ["offbeat_onset"]
        assert ev["suggestedPickupBeats"] is None

    def test_slightly_late_onset_is_not_offbeat(self) -> None:
        # A 50 ms lag inside the jitter tolerance is an on-beat
        # landing, not a mid-cell onset — no flag.
        est = _estimate(BEATS_120, first_onset_sec=0.05)
        assert pickup_uncertainty(est) is None


class TestAlignment:
    """Leading-beat synthesis keeps strengths index-aligned."""

    def test_dropped_first_beat_shifts_accent_phase(self) -> None:
        # Tracker missed beat 0 entirely; the synthesized leading
        # beat becomes index 0 with the neutral median strength, so
        # the real downbeats now read as phase 1 — a one-beat pickup
        # is the suggestion.
        est = _estimate(
            BEATS_120,
            first_onset_sec=-0.5,
            beat_strengths=_downbeat_strengths(0),
        )
        a = est.pickup_analysis
        assert a is not None
        assert a.leading_beats_added == 1
        assert a.first_beat_sec == 0.0
        assert est.beat_times_sec[0] == -0.5
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert "downbeat_phase_mismatch" in ev["flags"]
        assert ev["suggestedPickupBeats"] == 1

    def test_multi_beat_gap_walks_back_to_onset(self) -> None:
        # Two missing beats: the walk-back lands the earliest
        # synthesized beat on the onset; accents on the tracked
        # grid read as phase 2.
        est = _estimate(
            BEATS_120,
            first_onset_sec=-1.0,
            beat_strengths=_downbeat_strengths(0),
        )
        a = est.pickup_analysis
        assert a is not None
        assert a.leading_beats_added == 2
        assert est.beat_times_sec[:2] == (-1.0, -0.5)
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert "downbeat_phase_mismatch" in ev["flags"]
        assert ev["suggestedPickupBeats"] == 2

    def test_tracker_snap_drops_old_beat_and_strength(self) -> None:
        # Onset 0.2 s before a late-landing beat 0: the tracked beat
        # snaps to the onset and its strength goes with it — the
        # accent evidence then covers the snapped grid, not the
        # stale one.
        est = _estimate(
            BEATS_120,
            first_onset_sec=-0.2,
            beat_strengths=_downbeat_strengths(0),
        )
        a = est.pickup_analysis
        assert a is not None
        assert a.leading_beats_added == 1
        # beat_times[0] was dropped: 12 tracked - 1 + 1 leading.
        assert len(est.beat_times_sec) == 12
        assert est.beat_times_sec[0] == -0.2
        assert est.beat_times_sec[1] == 0.5


class TestEvidenceShape:
    """The issue evidence stays traceable (acceptance: inputs +
    candidates a reviewer can audit)."""

    def test_evidence_carries_inputs_and_candidates(self) -> None:
        est = _estimate(
            BEATS_120,
            first_onset_sec=0.0,
            beat_strengths=_downbeat_strengths(1),
        )
        ev = pickup_uncertainty(est)
        assert ev is not None
        assert ev["firstOnsetSec"] == 0.0
        assert ev["firstTrackedBeatSec"] == 0.0
        assert ev["medianBeatIntervalSec"] == 0.5
        assert ev["leadingBeatsAdded"] == 0
        candidates = ev["candidates"]
        assert {c["pickupBeats"] for c in candidates} == {0, 1, 2, 3}
        assert all(0.0 <= c["downbeatScore"] <= 1.0 for c in candidates)

    def test_fractional_measure_skips_phase_scoring(self) -> None:
        # A pulse unit that does not tile the meter leaves no
        # integral phase grid — candidates stay empty and nothing
        # flags (the raw pickup itself is still valid).
        est = _estimate(
            BEATS_120,
            first_onset_sec=0.0,
            beat_strengths=_downbeat_strengths(1),
            pulse_unit_ql=Fraction(2, 3),
            numerator=3,
            denominator=4,
        )
        a = est.pickup_analysis
        assert a is not None
        assert a.candidates == ()
        assert a.strength_available is False
        assert pickup_uncertainty(est) is None
