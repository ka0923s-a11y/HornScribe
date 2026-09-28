"""QNT-002/QNT-007: baseline+ablation benchmark harness, full B0–B4 arm set."""

from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction

import pytest

import rhythm_fixtures as fx
from hornscribe.rhythm import (
    DEFAULT_ARMS,
    OnsetMetrics,
    benchmark_methods,
    benchmark_onsets,
    onset_metrics,
)
from rhythm_fixtures import RhythmFixture

FixtureFactory = Callable[[], RhythmFixture]


@pytest.mark.parametrize(
    "make", fx.ALL_FIXTURES, ids=[m().name for m in fx.ALL_FIXTURES]
)
def test_benchmark_emits_all_method_metrics(make: FixtureFactory) -> None:
    """Acceptance: B0-B4 + ablation metrics emitted per fixture."""
    fixture = make()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_durations_ql=fixture.expected_durations_ql,
        expected_rest_spans_ql=fixture.expected_rest_spans_ql,
        expected_tuplet_groups=fixture.expected_tuplet_groups,
        meter_map=fixture.meter_map,
    )
    expected_arms = set(DEFAULT_ARMS)
    try:
        import music21  # noqa: F401
    except ImportError:
        expected_arms.discard("B2")
    assert set(metrics) == expected_arms
    for name, m in metrics.items():
        assert m.method == name
        assert m.expected_count == len(fixture.expected_onsets_ql)
        assert m.monotonic  # every method honors the monotonic contract
        assert 0.0 <= m.exact_onset_rate <= 1.0
        if fixture.expected_durations_ql is not None:
            assert m.exact_duration_rate is not None
        if fixture.expected_rest_spans_ql is not None:
            assert m.rest_exact_rate is not None
    assert metrics["B4"].total_cost is not None
    assert metrics["B0"].total_cost is None
    # realized methods report notation-complexity counts; baselines do not
    assert metrics["B4"].symbol_count is not None
    assert metrics["B3"].symbol_count is not None
    assert metrics["B0"].symbol_count is None
    # only HSQ arms carry review-issue counts from diagnostics
    assert metrics["B4"].review_issue_count is not None
    assert metrics["B0"].review_issue_count is None


def test_arm_selection() -> None:
    fixture = fx.quarters_exact()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        arms=("B0", "B4"),
    )
    assert set(metrics) == {"B0", "B4"}
    with pytest.raises(ValueError, match="unknown benchmark arms"):
        benchmark_onsets(
            fixture.events,
            fixture.warp,
            fixture.expected_onsets_ql,
            arms=("B0", "B9"),
        )


def test_benchmark_deterministic() -> None:
    fixture = fx.quarters_jitter50()
    a = benchmark_onsets(fixture.events, fixture.warp, fixture.expected_onsets_ql)
    b = benchmark_onsets(fixture.events, fixture.warp, fixture.expected_onsets_ql)
    assert a == b


def test_benchmark_methods_records_runtime() -> None:
    """The timed variant returns identical metrics plus a runtime (QNT-007)."""
    fixture = fx.quarters_exact()
    timed = benchmark_methods(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    plain = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    assert set(timed) == set(plain)
    for name, run in timed.items():
        assert run.runtime_sec >= 0.0
        assert run.metrics == plain[name]


def test_hsq_beats_baselines_on_ioi_fixture() -> None:
    """The IOI pair: HSQ exact where independent snapping fails (design 37)."""
    fixture = fx.ioi_pair_fixture()
    metrics = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    assert metrics["B4"].exact_onset_rate == 1.0
    assert metrics["B0"].exact_onset_rate == 0.5
    assert metrics["B1"].exact_onset_rate == 0.5
    # QNT-003: the joint realization's notation cost alone also recovers the
    # pair (a 5/4 span needs an ugly tie), so the realized no-IOI ablation
    # no longer degrades to baseline on this fixture. In the *timing-only*
    # context the IOI term is still load-bearing: B3-no-ioi regresses.
    assert metrics["B4-no-ioi"].exact_onset_rate == 1.0
    assert metrics["B3"].exact_onset_rate == 1.0
    # #78: the pair is also a *global* ~60 ms latency — the meter-aware
    # alignment pull resolves it upstream of the DP, so the timing-only
    # no-IOI arm no longer regresses here. The DP-level IOI contribution
    # stays covered by test_ioi_cost_recovers_consistent_shift (shift
    # search off).
    assert metrics["B3-no-ioi"].exact_onset_rate == 1.0


def test_b4_beats_nearest_grid_on_latency65() -> None:
    """+65 ms latency defeats independent snapping; the joint DP recovers."""
    fixture = fx.quarters_latency65()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_durations_ql=fixture.expected_durations_ql,
    )
    assert metrics["B4"].exact_onset_rate == 1.0
    assert metrics["B0"].exact_onset_rate < 1.0
    assert metrics["B1"].exact_onset_rate < 1.0
    # #78: the band-aliased alignment is *resolved*, not merely flagged —
    # among the competing phases (true -65 ms vs the index-aliased +60 ms),
    # the metrical tie-break lands the quarters on beats instead of odd
    # sixteenths, so the correct -65 ms applies cleanly upstream of the DP.
    assert metrics["B4"].review_issue_count == 0


def test_tiny_rest_ablation_on_articulation_fixture() -> None:
    """Design 13: tonguing gaps are not rests — the tiny-rest penalty is the
    load-bearing term (QNT-007 acceptance)."""
    fixture = fx.articulation_gaps()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_durations_ql=fixture.expected_durations_ql,
        expected_rest_spans_ql=fixture.expected_rest_spans_ql,
    )
    assert metrics["B4"].tiny_rest_count == 0
    assert metrics["B4"].rest_exact_rate == 1.0
    # timing-only and no-tiny-rest arms fragment the line into 16th rests
    assert metrics["B3"].tiny_rest_count is not None
    assert metrics["B3"].tiny_rest_count > 0
    assert metrics["B4-no-tiny-rest"].tiny_rest_count is not None
    assert metrics["B4-no-tiny-rest"].tiny_rest_count > 0


def test_real_sixteenth_rest_survives_tiny_rest_penalty() -> None:
    """rests_sixteenth: the penalty must not erase a *real* 16th rest."""
    fixture = fx.rests_sixteenth()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_rest_spans_ql=fixture.expected_rest_spans_ql,
    )
    assert metrics["B4"].rest_exact_rate == 1.0
    assert metrics["B4"].rest_extra_count == 0


def test_triplet_classification_metrics() -> None:
    """Triplet classification: groups committed on triplet fixtures, zero
    false positives on the near-triplet binary fixture (issue metric)."""
    triplet = fx.triplet_eighths_exact()
    metrics = benchmark_onsets(
        triplet.events,
        triplet.warp,
        triplet.expected_onsets_ql,
        expected_tuplet_groups=triplet.expected_tuplet_groups,
    )
    assert metrics["B4"].tuplet_group_count == 2
    assert metrics["B4"].triplet_false_positive_groups == 0
    assert metrics["B4"].triplet_missed_groups == 0

    straight = fx.eighths_jitter_straight()
    metrics = benchmark_onsets(
        straight.events,
        straight.warp,
        straight.expected_onsets_ql,
        expected_tuplet_groups=straight.expected_tuplet_groups,
    )
    assert metrics["B4"].tuplet_group_count == 0
    assert metrics["B4"].triplet_false_positive_groups == 0

    compound = fx.meter_68_eighths()
    metrics = benchmark_onsets(
        compound.events,
        compound.warp,
        compound.expected_onsets_ql,
        meter_map=compound.meter_map,
        expected_tuplet_groups=compound.expected_tuplet_groups,
    )
    # native ternary subdivision is meter structure, never a tuplet
    assert metrics["B4"].tuplet_group_count == 0
    assert metrics["B4"].triplet_false_positive_groups == 0


def test_horn_like_fixtures_readability() -> None:
    """Horn layer: breath gaps and legato overlaps never become rests."""
    for make in (fx.horn_breath_gaps, fx.horn_legato_overlap):
        fixture = make()
        metrics = benchmark_onsets(
            fixture.events,
            fixture.warp,
            fixture.expected_onsets_ql,
            expected_rest_spans_ql=fixture.expected_rest_spans_ql,
        )
        assert metrics["B4"].exact_onset_rate == 1.0
        assert metrics["B4"].rest_exact_rate == 1.0
        assert metrics["B4"].rest_extra_count == 0
        assert metrics["B4"].tiny_rest_count == 0


def test_onset_metrics_fields() -> None:
    fixture = fx.quarters_exact()
    metrics = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    hsq = metrics["B4"]
    assert hsq.exact_onset_rate == 1.0
    assert hsq.mean_abs_onset_error_ql == 0.0
    assert hsq.max_abs_onset_error_ql == 0.0
    assert hsq.matched_count == len(fixture.expected_onsets_ql)


def test_onset_metrics_partial_errors() -> None:
    from hornscribe.rhythm import normalize_to_score_time
    from hornscribe.rhythm.baselines import snap_nearest_grid

    fixture = fx.ioi_pair_fixture()
    quantized = snap_nearest_grid(normalize_to_score_time(fixture.events, fixture.warp))
    m = onset_metrics("B0", quantized, fixture.expected_onsets_ql)
    assert m.matched_count == 1
    assert m.exact_onset_rate == 0.5
    assert m.max_abs_onset_error_ql == pytest.approx(0.25)


def test_rest_metrics_exact_match() -> None:
    """Rest correctness: exact (onset, duration) span matching + extras."""
    fixture = fx.rests_44()
    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_rest_spans_ql=fixture.expected_rest_spans_ql,
    )
    assert metrics["B4"].rest_exact_rate == 1.0
    assert metrics["B4"].rest_extra_count == 0
    # naive baselines emit no rests -> all expected spans missed
    assert metrics["B0"].rest_exact_count == 0
    assert metrics["B0"].rest_exact_rate == 0.0


def test_metrics_validation() -> None:
    with pytest.raises(ValueError):
        OnsetMetrics(
            method="x",
            note_count=0,
            expected_count=0,
            matched_count=0,
            exact_onset_rate=float("nan"),
            mean_abs_onset_error_ql=0.0,
            max_abs_onset_error_ql=0.0,
            monotonic=True,
        )


def test_music21_baseline_optional() -> None:
    """B2: music21 Stream.quantize wrapper — quantized onsets on the 16th
    grid, quantized durations when ``process_durations`` is on."""
    m21 = pytest.importorskip("music21")
    del m21
    from hornscribe.rhythm import normalize_to_score_time
    from hornscribe.rhythm.music21_baseline import quantize_with_music21

    fixture = fx.quarters_exact()
    normalized = normalize_to_score_time(fixture.events, fixture.warp)
    out = quantize_with_music21(normalized)
    assert [n.onset_ql for n in out] == list(fixture.expected_onsets_ql)
    # processDurations=True: 0.9 ql performed quarters quantize to 1 ql
    assert [n.duration_ql for n in out] == [Fraction(1)] * len(out)

    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
    )
    assert metrics["B2"].exact_onset_rate == 1.0
    assert metrics["B2"].monotonic
    # B2 emits no realization — notation-complexity metrics stay None
    assert metrics["B2"].symbol_count is None
