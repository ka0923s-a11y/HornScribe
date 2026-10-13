"""#248: tempo_map_from_estimate aggregates per measure, not per beat."""

from __future__ import annotations

from fractions import Fraction

import pytest

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


def test_auto_fallback_rounds_to_integer_bpm() -> None:
    """#249: the no-track auto fallback printed 151.39-style marks —
    every other path already emits integer BPM."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    est = TempoEstimate(
        warp=TimeWarp.fixed_bpm(151.39),
        beat_times_sec=(),
        median_bpm=151.39,
        auto=True,
    )
    segs = tempo_map_from_estimate(est, meter)
    assert segs[0].bpm == 151.0


def test_manual_tempo_prints_as_entered() -> None:
    """#249: a pinned manual tempo is the user's word — verbatim, not
    rounded (the UI sends integers; a stored decimal stays exact)."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    est = TempoEstimate(
        warp=TimeWarp.fixed_bpm(97.5),
        beat_times_sec=(),
        median_bpm=97.5,
        auto=False,
    )
    segs = tempo_map_from_estimate(est, meter)
    assert segs[0].bpm == 97.5


def test_steady_tempo_jitter_does_not_emit_marks() -> None:
    """±1 % inter-beat jitter inside a measure must not print tempo marks."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 16 quarter beats at ~120 BPM with alternating ±1 % jitter.
    intervals = [0.5 * (1.01 if i % 2 else 0.99) for i in range(16)]
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 1
    assert segs[0].start_beat == 0
    assert 118.0 < segs[0].bpm < 122.0


def test_frame_level_jitter_collapses_to_single_mark() -> None:
    """#202: real tracker noise is +-1-2 hops per ANCHOR — on a steady
    pulse that amplifies to +-15 % per-measure tempo swings, which used
    to print a fresh mark every bar (JPOP loopback: 151->122->168->...).
    Anchor residuals hug the LSQ line, so the map collapses to one mark.
    """
    import random

    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    rng = random.Random(202)
    hop = 512.0 / 22050.0  # librosa default hop at sr=22050
    grid = [i * 0.455 for i in range(48)]  # ~132 BPM quarter beats
    times = [grid[0]]
    for t in grid[1:]:
        jitter = rng.uniform(-1.5, 1.5) * hop
        times.append(max(t + jitter, times[-1] + 0.05))
    # Sanity: the per-measure instantaneous rate really does swing
    # beyond +-8 % — the collapse must come from the anchor test,
    # not from the jitter being small.
    intervals = [b - a for a, b in zip(times, times[1:], strict=False)]
    lo, hi = min(intervals), max(intervals)
    assert (hi - lo) / lo > 0.10
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
        median_bpm=60.0 / 0.455,
        auto=True,
    )
    segs = tempo_map_from_estimate(est, meter)
    assert len(segs) == 1
    assert segs[0].start_beat == 0
    assert abs(segs[0].bpm - 132.0) < 3.0


def test_dropped_anchor_defeats_steady_collapse() -> None:
    """#202: a missed beat (one ~2x interval) must not print phantom
    tempo marks — the warp absorbs the gap, the printed tempo stays."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.5] * 10 + [1.0] + [0.5] * 10
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    # The double-interval beats land inside one measure whose warp rate
    # still averages ~120 — no spurious slow/fast mark may appear.
    assert len(segs) <= 2
    assert all(abs(s.bpm - 120.0) < 8.0 for s in segs)


def test_emitted_marks_are_integer_bpm() -> None:
    """#202: marks print as integers — 151.39-style decimals are false
    precision on a tracked tempo."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.5] * 4 + [60.0 / 88.6] * 4
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 2
    assert all(s.bpm == float(int(s.bpm)) for s in segs)


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


def test_trailing_anchor_past_last_onset_emits_no_mark() -> None:
    """#128 follow-up: beat anchors keep ticking into the decay tail,
    so the lattice can hold a measure with no onsets. Its tail-
    extrapolated rate used to print a mark at the piece's end that
    swallowed the genuine mid-piece step ({0:99, 16:154} instead of
    {0:99, 8:140} on bench tempo-step-4-4)."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 2 measures at 100 BPM, 2 at 140, then one short tail anchor in
    # measure 4 (~154 BPM extrapolation).
    intervals = [0.6] * 7 + [60.0 / 140.0] * 8 + [0.39]
    est = _estimate(intervals)
    last_onset_sec = 7.8  # beat 15 (ql 15, measure 3)
    # #133: even without the onset bound a measure past the last
    # anchor has zero measured span and emits nothing — but measure 3
    # still absorbs the tail anchor's own fast interval (143 vs 140),
    # which only the onset bound can cut out.
    unbounded = tempo_map_from_estimate(est, meter)
    assert all(s.start_beat < 16 for s in unbounded)
    assert unbounded[-1].start_beat == 8
    assert unbounded[-1].bpm > 140.0
    segs = tempo_map_from_estimate(
        est, meter, last_onset_sec=last_onset_sec
    )
    assert len(segs) == 2
    assert segs[0].start_beat == 0
    assert abs(segs[0].bpm - 100.0) < 0.5
    assert segs[1].start_beat == 8
    # The onset bound cuts the tail interval out of measure 3's rate —
    # the printed mark now reads within ~2 % of the settled tempo.
    assert abs(segs[1].bpm - 140.0) < 3.0


def test_final_measure_with_no_measured_span_emits_no_mark() -> None:
    """#133: a last onset at the barline leaves the closing measure
    essentially unmeasured — it must not print a rate of its own, and
    the settled episode's mark carries to the piece's end."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.6] * 7 + [60.0 / 140.0] * 8 + [0.39]
    est = _estimate(intervals)
    # Onset lands on the measure-3 barline (ql 12): measure 3 keeps
    # under half a beat of measured span, so no mark is minted there —
    # the 140 episode from measure 2 continues to the end.
    segs = tempo_map_from_estimate(est, meter, last_onset_sec=6.343)
    assert all(s.start_beat != 12 for s in segs)
    assert segs[-1].start_beat == 8
    assert abs(segs[-1].bpm - 140.0) < 3.0


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


def test_leading_beats_walk_back_on_local_interval() -> None:
    """rubato-4-4: when the tracker drops several opening beats the
    refill must space synthesized anchors on the LOCAL interval at the
    track boundary — on a rit./accel. the early beats run faster than
    the global median, so median-spaced fill lands every anchor off
    the real pulse."""
    from hornscribe.transcription.tempo import estimate_tempo

    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # Tracked beats start at 2.04 s with ~0.51 s local spacing that
    # drifts up to 0.75 s later — global median (~0.565) differs from
    # the boundary-local interval (~0.515) enough to discriminate.
    times = [2.04]
    for d in (0.50, 0.51, 0.52, 0.53, 0.60, 0.65, 0.70, 0.75):
        times.append(times[-1] + d)
    est = estimate_tempo(
        None,
        22050,
        meter,
        tempo_bpm=None,
        first_onset_sec=0.0,
        beat_times=tuple(times),
    )
    # Four missing beats refilled at the local ~0.515 s spacing:
    # anchors at 0.0 / 0.515 / 1.03 / 1.545 s map to beats 0-3.
    warp = est.warp
    assert float(warp.seconds_to_ql(0.0)) == pytest.approx(0.0, abs=0.02)
    assert float(warp.seconds_to_ql(0.515)) == pytest.approx(1.0, abs=0.02)
    assert float(warp.seconds_to_ql(1.03)) == pytest.approx(2.0, abs=0.02)


_DYN_FRAME_SEC = 512.0 / 22050.0


def test_plateau_grouping_splits_drift_staircase() -> None:
    """rubato-4-4: a continuous rit. quantizes the autocorr tempo
    curve into a staircase — each plateau must become its own region
    so the per-region re-track follows the drift instead of averaging
    it into one tempo the DP cannot hold."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    levels = (117.5, 112.3, 107.7, 103.4, 99.4, 95.7, 92.3)
    dyn = [v for level in levels for v in (level,) * 115]  # ~2.7 s each
    regions = _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC)
    assert len(regions) == len(levels)
    assert regions[0][2] == pytest.approx(117.5, abs=0.5)
    assert regions[-1][2] == pytest.approx(92.3, abs=0.5)


def test_plateau_grouping_steady_tempo_stays_one_region() -> None:
    """Sub-band quantisation jitter (~1 %) must not split a steady
    tempo — fewer than two survivors means the caller keeps the
    single global track."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    dyn = [121.4 if i % 2 else 120.0 for i in range(400)]
    assert _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC) == []


def test_plateau_grouping_folds_short_plateau() -> None:
    """A sub-second tempo blip folds into its tempo-nearer neighbour;
    the two real plateaus survive as regions."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    dyn = [120.0] * 200 + [131.0] * 22 + [140.0] * 200
    regions = _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC)
    assert len(regions) == 2
    assert regions[0][2] < 125.0
    assert regions[1][2] > 135.0


def test_plateau_fold_weights_blips_by_duration() -> None:
    """A lone-frame flicker must not halve a long plateau's tempo.

    milk-crescendo: the autocorr curve of a steady ~143.5 bpm song
    flickered to its triplet level (95.7 = 2/3 x) on ~150 scattered
    single frames; the unweighted fold mean dragged the host region to
    a fictitious ~119.6 bpm and the region re-track locked the wrong
    pulse for 100 s of music. Duration-weighted folding keeps the
    plateau's tempo and the piece collapses to the global track.
    """
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    dyn = [143.55] * 200 + [95.7] + [143.55] * 200
    assert _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC) == []

    # Scattered single-frame blips across the whole span: same story.
    dyn = []
    for i in range(400):
        dyn.append(95.7 if i % 17 == 8 else 143.55)
    assert _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC) == []


def test_metrical_snap_short_region() -> None:
    """A short span reading the triplet level of the dominant tempo is
    a metrical-level confusion, not a tempo change: it snaps to the
    dominant grid and merges, so the caller keeps the global track."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    dyn = [143.55] * 200 + [95.7] * 100 + [143.55] * 200
    assert _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC) == []


def test_metrical_snap_long_region_kept() -> None:
    """A tempo plateau LONGER than the snap cap keeps its own reading
    even at a ratio of the other sections: sustained sections are real
    tempo structure, not autocorr flicker."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    # 400 frames ~9.3 s > _TEMPO_REGION_SNAP_MAX_SEC, and 110 bpm is
    # off-ratio vs the dominant 110 bpm mid-section anyway (it is the
    # majority), so the 143.55 bookends must not be re-labelled.
    dyn = [143.55] * 100 + [110.0] * 400 + [143.55] * 100
    regions = _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC)
    assert len(regions) == 3
    assert regions[1][2] == pytest.approx(110.0, abs=0.5)


def test_region_bpm_is_member_median_not_polluted_mean() -> None:
    """A long plateau that absorbed a minority of off-level frames
    reports the member median -- the tempo the DP should chase."""
    from hornscribe.transcription.pipeline import _tempo_regions_from_dyn

    # 60-frame (~1.4 s) plateau at 95.7 inside a 143.55 span: too short
    # to be its own region, folded in; the host must still read ~143.55
    # if another distinct plateau forces the region path.
    dyn = [143.55] * 150 + [95.7] * 60 + [143.55] * 150 + [80.0] * 200
    regions = _tempo_regions_from_dyn(dyn, _DYN_FRAME_SEC)
    assert len(regions) == 2
    assert regions[0][2] == pytest.approx(143.55, abs=0.5)
    assert regions[1][2] == pytest.approx(80.0, abs=0.5)


def test_reverting_deviation_episodes_do_not_emit() -> None:
    """#231: a 1-2 measure dip that REVERTS is tracker re-phasing, not
    a tempo change -- real mixes (JPOP loopback) swing +-10 % every
    phrase boundary and used to print ~25 marks on one steady song."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 4 measures ~120 BPM, then 2-measure 80 BPM dips that each revert:
    # large enough to defeat the #202 steady-track collapse, short
    # enough that no episode reaches _TEMPO_PERSIST_MEASURES.
    intervals = (
        [0.5] * 16  # 4 measures ~120 BPM
        + [0.75] * 8  # 2 measures ~80 BPM (dip)
        + [0.5] * 16  # back to ~120
        + [0.75] * 8  # second dip
        + [0.5] * 16  # back to ~120
    )
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 1
    assert abs(segs[0].bpm - 120.0) < 6.0


def test_sustained_tempo_change_survives_persistence() -> None:
    """#231: a deviation that HOLDS its new level past the persistence
    window is a real change -- it emits at the measure it began."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.5] * 16 + [60.0 / 90.0] * 24  # 4 meas @120 -> 6 meas @90
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 2
    assert segs[1].start_beat == 16  # deviation onset = measure 4
    assert abs(segs[1].bpm - 90.0) < 3.0


def test_final_jump_still_marks_at_track_end() -> None:
    """#231: a clear, held tempo change into the final measures is a
    real rit./shift even without a full persistence window."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.5] * 24 + [60.0 / 90.0] * 4  # ends on 90 after 120
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) == 2
    assert segs[1].start_beat == 24
    assert abs(segs[1].bpm - 90.0) < 3.0


def test_sustained_ritardando_marks_each_drifting_measure() -> None:
    """#199: a continuous rit. is a RAMP, not a step — the episode
    model's single late mark used to lag the warp by whole beats
    (rubato-4-4 onset F1 0.59, axis 133 ms). Once a pending run keeps
    stepping one direction at ramp scale, each drifting measure earns
    its own mark and the drift keeps marking per-measure until it
    ends."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    # 32 beats slowing linearly 120 -> 90 bpm across 8 measures.
    intervals = [
        60.0 / (120.0 + (90.0 - 120.0) * k / 31) for k in range(31)
    ]
    segs = tempo_map_from_estimate(_estimate(intervals), meter)
    assert len(segs) >= 5
    assert all(s.start_beat % 4 == 0 for s in segs)
    # A monotone drift never reverses its marks.
    assert all(
        later.bpm <= earlier.bpm
        for earlier, later in zip(segs, segs[1:], strict=False)
    )
    # The closing mark tracks the drift's real level — the old
    # staircase froze ~15 bpm high through the whole second half.
    assert segs[-1].bpm <= 100.0


def test_ramp_does_not_mark_a_discrete_step_run() -> None:
    """#199: a step change with a mixed transition measure is NOT a
    ramp — the >15 % run step disqualifies it, and emit_pos still
    places the single mark at the settled measure."""
    meter = MeterSegment(start_ql=Fraction(0), numerator=4, denominator=4)
    intervals = [0.6] * 7 + [60.0 / 140.0] * 8 + [0.39]
    segs = tempo_map_from_estimate(
        _estimate(intervals), meter, last_onset_sec=7.8
    )
    assert len(segs) == 2
    assert segs[1].start_beat == 8
    assert abs(segs[1].bpm - 140.0) < 3.0
