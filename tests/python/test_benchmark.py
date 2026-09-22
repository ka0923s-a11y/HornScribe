"""QNT-002: onset-metric benchmark harness + optional music21 baseline."""

from __future__ import annotations

from collections.abc import Callable

import pytest

import rhythm_fixtures as fx
from hornscribe.rhythm import OnsetMetrics, benchmark_onsets, onset_metrics
from rhythm_fixtures import RhythmFixture

FixtureFactory = Callable[[], RhythmFixture]


@pytest.mark.parametrize(
    "make", fx.ALL_FIXTURES, ids=[m().name for m in fx.ALL_FIXTURES]
)
def test_benchmark_emits_all_method_metrics(make: FixtureFactory) -> None:
    """Acceptance: B0/B1/HSQ onset metrics emitted per fixture."""
    fixture = make()
    metrics = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql,
        meter_map=fixture.meter_map,
    )
    assert set(metrics) == {"B0", "B1", "HSQ", "HSQ-no-ioi", "HSQ-timing"}
    for name, m in metrics.items():
        assert m.method == name
        assert m.expected_count == len(fixture.expected_onsets_ql)
        assert m.monotonic  # every method honors the monotonic contract
        assert 0.0 <= m.exact_onset_rate <= 1.0
    assert metrics["HSQ"].total_cost is not None
    assert metrics["B0"].total_cost is None
    # realized methods report notation-complexity counts; baselines do not
    assert metrics["HSQ"].symbol_count is not None
    assert metrics["HSQ-timing"].symbol_count is not None
    assert metrics["B0"].symbol_count is None


def test_benchmark_deterministic() -> None:
    fixture = fx.quarters_jitter50()
    a = benchmark_onsets(fixture.events, fixture.warp, fixture.expected_onsets_ql)
    b = benchmark_onsets(fixture.events, fixture.warp, fixture.expected_onsets_ql)
    assert a == b


def test_hsq_beats_baselines_on_ioi_fixture() -> None:
    """The IOI pair: HSQ exact where independent snapping fails (design 37)."""
    fixture = fx.ioi_pair_fixture()
    metrics = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    assert metrics["HSQ"].exact_onset_rate == 1.0
    assert metrics["B0"].exact_onset_rate == 0.5
    assert metrics["B1"].exact_onset_rate == 0.5
    # QNT-003: the joint realization's notation cost alone also recovers the
    # pair (a 5/4 span needs an ugly tie), so the no-IOI ablation no longer
    # degrades to baseline on this fixture. The timing-only ablation keeps
    # the IOI term, so it stays exact too — the timing terms' isolated
    # contribution is covered in test_hsq_dp.test_ioi_cost_recovers_consistent_shift.
    assert metrics["HSQ-no-ioi"].exact_onset_rate == 1.0
    assert metrics["HSQ-timing"].exact_onset_rate == 1.0


def test_onset_metrics_fields() -> None:
    fixture = fx.quarters_exact()
    metrics = benchmark_onsets(
        fixture.events, fixture.warp, fixture.expected_onsets_ql
    )
    hsq = metrics["HSQ"]
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
    """B2: music21 Stream.quantize wrapper — quantized onsets on the 16th grid."""
    m21 = pytest.importorskip("music21")
    del m21
    from hornscribe.rhythm import normalize_to_score_time
    from hornscribe.rhythm.music21_baseline import quantize_with_music21

    fixture = fx.quarters_exact()
    normalized = normalize_to_score_time(fixture.events, fixture.warp)
    out = quantize_with_music21(normalized)
    assert [n.onset_ql for n in out] == list(fixture.expected_onsets_ql)

    metrics = benchmark_onsets(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        include_music21=True,
    )
    assert metrics["music21"].exact_onset_rate == 1.0
    assert metrics["music21"].monotonic
