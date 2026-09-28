"""#248: tempo_map_from_estimate aggregates per measure, not per beat."""

from __future__ import annotations

from fractions import Fraction

from hornscribe.rhythm.beatmap import BeatAnchor, BeatMap, BeatSource
from hornscribe.rhythm.meter import MeterSegment
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.transcription.tempo import TempoEstimate, tempo_map_from_estimate


def _estimate(
    intervals_sec: list[float],
    *,
    pulse_unit_ql: Fraction = Fraction(1),
    pickup_len_ql: Fraction = Fraction(0),
    shift_ql: Fraction = Fraction(0),
    median_bpm: float = 120.0,
) -> TempoEstimate:
    """Tracked-tempo estimate from a list of inter-beat intervals.

    Anchor i sits at score position ``i * pulse_unit_ql + shift_ql``,
    mirroring estimate_tempo's beat-map layout (shift = pickup lift).
    """
    times = [0.0]
    for dt in intervals_sec:
        times.append(times[-1] + dt)
    anchors = tuple(
        BeatAnchor(
            time_sec=t,
            score_pos_ql=Fraction(i) * pulse_unit_ql + shift_ql,
            source=BeatSource.BEAT_TRACKER,
        )
        for i, t in enumerate(times)
    )
    return TempoEstimate(
        warp=TimeWarp.from_beat_map(BeatMap(anchors)),
        beat_times_sec=tuple(times),
        median_bpm=median_bpm,
        auto=True,
        pickup_len_ql=pickup_len_ql,
        pulse_unit_ql=pulse_unit_ql,
    )


def test_pinned_or_short_track_single_segment() -> None:
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    fixed = TempoEstimate(
        warp=TimeWarp.fixed_bpm(120.0),
        beat_times_sec=(),
        median_bpm=100.0,
        auto=False,
    )
    segs = tempo_map_from_estimate(fixed, meter)
    assert len(segs) == 1
    assert segs[0].start_beat == 0
    assert segs[0].bpm == 100.0


def test_steady_tempo_jitter_does_not_emit_marks() -> None:
    """±1 % inter-beat jitter inside a measure must not print tempo marks."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 16 quarter beats at ~120 BPM with alternating ±1 % jitter.
    intervals = [0.5 * (1.01 if i % 2 else 0.99) for i in range(16)]
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 1
    assert segs[0].start_beat == 0
    assert 118.0 < segs[0].bpm < 122.0


def test_genuine_tempo_change_lands_on_measure_boundary() -> None:
    """A real change emits one segment at the measure start, not mid-bar."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 4 beats at 120 BPM (measure 0), then 4 beats at ~90 BPM (measure 1).
    intervals = [0.5] * 4 + [60.0 / 90.0] * 4
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 2
    assert segs[0].start_beat == 0
    assert abs(segs[0].bpm - 120.0) < 0.5
    assert segs[1].start_beat == 4  # measure 1 boundary, beats
    assert abs(segs[1].bpm - 90.0) < 0.5


def test_ritardando_survives_as_measure_stair_steps() -> None:
    """A gradual rit. across several measures keeps a coarse tempo map."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 12 beats slowing steadily 120 -> ~90 BPM (3 measures).
    intervals = [0.5 + i * (60.0 / 90.0 - 0.5) / 11 for i in range(12)]
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) >= 2
    assert all(s.start_beat % 4 == 0 for s in segs)
    assert segs[-1].bpm < segs[0].bpm


def test_pickup_measure_buckets_before_first_downbeat() -> None:
    """Pickup beat intervals belong to measure 0; the first full measure
    starts at beat 1 for a one-quarter pickup in 4/4."""
    meter = MeterSegment(
        start_ql=Fraction(0),
        numerator=4,
        denominator=4,
        measure_phase_ql=Fraction(3),
    )
    # Pickup anchor at ql=0 (the pickup beat), then the grid continues:
    # anchors 0-4 at 120 BPM cover the pickup + measure 1, anchors 5+
    # at 90 BPM fill measure 2 (which starts at beat 5).
    intervals = [0.5] * 5 + [60.0 / 90.0] * 8
    est = _estimate(
        intervals,
        pickup_len_ql=Fraction(1),
    )
    segs = tempo_map_from_estimate(est, meter)
    assert len(segs) == 2
    assert segs[0].start_beat == 0
    assert abs(segs[0].bpm - 120.0) < 0.5
    # Measure 2 starts at ql=5 -> beat 5; the change lands there.
    assert segs[1].start_beat == 5
    assert abs(segs[1].bpm - 90.0) < 0.5


def test_compound_meter_reports_primary_beat_bpm() -> None:
    """6/8 tracks eighths (pulse unit 1/2 ql); the map reports dotted-
    quarter BPM and aggregates on 3-ql measures."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=6, denominator=8)
    # 6 eighths at 0.25 s = 80 dotted-quarter BPM (measure 0), then
    # 6 eighths at 0.2 s = 100 BPM (measure 1).
    intervals = [0.25] * 6 + [0.2] * 6
    est = _estimate(intervals, pulse_unit_ql=Fraction(1, 2), median_bpm=80.0)
    segs = tempo_map_from_estimate(est, meter)
    assert len(segs) == 2
    assert segs[0].start_beat == 0
    assert abs(segs[0].bpm - 80.0) < 0.5
    # Measure 1 starts at ql=3; the payload beat for 6/8 is an eighth
    # (4/denominator = 0.5 ql), so the boundary lands on beat 6.
    assert segs[1].start_beat == 6
    assert abs(segs[1].bpm - 100.0) < 0.5


def test_median_bpm_uses_anchor_slope_not_interval_median() -> None:
    """Alternating +-1-frame intervals: the interval median reports a
    whole-frame quantum, while the anchor regression recovers the
    mean period (frame-quantisation bias fix)."""
    from hornscribe.transcription.tempo import estimate_tempo

    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    times = [0.0]
    for i in range(10):
        times.append(times[-1] + (0.44 if i % 2 else 0.49))
    est = estimate_tempo(
        None,
        22050,
        meter,
        tempo_bpm=None,
        first_onset_sec=None,
        beat_times=tuple(times),
    )
    # Mean interval 0.465 s -> ~129.0 bpm. The interval median picks
    # 0.49 -> ~122.4 bpm; the slope must win within the outlier guard.
    assert abs(est.median_bpm - 129.0) < 1.5


def test_tempo_map_uses_warp_rate_at_measure_bounds() -> None:
    """A tempo step's mixed interval crosses a barline: the slow measure
    must keep ~100 while the fast side reports ~140 — the boundary-
    interpolated warp rate, not an LSQ over inside anchors."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    times = [0.0]
    for d in [0.6] * 7 + [0.45] + [0.43] * 8:
        times.append(times[-1] + d)
    anchors = tuple(
        BeatAnchor(
            time_sec=t,
            score_pos_ql=Fraction(i),
            source=BeatSource.BEAT_TRACKER,
        )
        for i, t in enumerate(times)
    )
    est = TempoEstimate(
        warp=TimeWarp.from_beat_map(BeatMap(anchors)),
        beat_times_sec=tuple(times),
        median_bpm=120.0,
        auto=True,
    )
    segs = tempo_map_from_estimate(est, meter)
    assert abs(segs[0].bpm - 100.0) < 2.0
    fast = [s for s in segs if s.start_beat >= 8]
    assert fast and all(abs(s.bpm - 140.0) < 8.0 for s in fast)
