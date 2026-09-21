"""QNT-002 acceptance: HSQ onset DP, alignment shift, k-best alternatives."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from fractions import Fraction
from itertools import pairwise

import pytest

import rhythm_fixtures as fx
from hornscribe.domain.ids import RawNoteEventId
from hornscribe.rhythm import (
    NormalizedNote,
    QuantizationAlternative,
    QuantizationProfile,
    TripletPolicy,
    estimate_alignment_shift,
    normalize_to_score_time,
    quantize_events,
    quantize_normalized,
)
from rhythm_fixtures import RhythmFixture

FixtureFactory = Callable[[], RhythmFixture]


def _onsets(alternative: QuantizationAlternative) -> list[Fraction]:
    return [n.onset_ql for n in alternative.notes]


def _expected(fixture: RhythmFixture) -> list[Fraction]:
    return list(fixture.expected_onsets_ql)


# --- straight rhythms quantize exactly (acceptance) ---------------------------------

STRAIGHT: tuple[FixtureFactory, ...] = (
    fx.quarters_exact,
    fx.eighths_exact,
    fx.sixteenths_exact,
    fx.syncopated_exact,
)


@pytest.mark.parametrize("make", STRAIGHT, ids=[m().name for m in STRAIGHT])
def test_straight_rhythms_exact(make: FixtureFactory) -> None:
    fixture = make()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert alts[0].rank == 1
    assert _onsets(alts[0]) == _expected(fixture)
    assert all(isinstance(n.onset_ql, Fraction) for n in alts[0].notes)


def test_normalized_input_path_matches_events_path() -> None:
    """quantize_normalized = quantize_events without the shift search."""
    fixture = fx.quarters_exact()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    direct = quantize_normalized(notes, fixture.meter_map)
    via_events = quantize_events(
        fixture.events, fixture.warp, fixture.meter_map, search_alignment=False
    )
    assert _onsets(direct[0]) == _onsets(via_events[0]) == _expected(fixture)


# --- jitter recovery (acceptance: ±20/50 ms at configured BPM) -----------------------

JITTERED: tuple[FixtureFactory, ...] = (fx.quarters_jitter20, fx.quarters_jitter50)


@pytest.mark.parametrize("make", JITTERED, ids=[m().name for m in JITTERED])
def test_jitter_recovers_grid(make: FixtureFactory) -> None:
    fixture = make()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert _onsets(alts[0]) == _expected(fixture)


# --- global +40 ms latency (acceptance: deterministic shift handling) -----------------


def test_latency_estimate_is_deterministic() -> None:
    fixture = fx.quarters_latency40()
    profile = QuantizationProfile()
    est1 = estimate_alignment_shift(fixture.events, fixture.warp, profile)
    est2 = estimate_alignment_shift(fixture.events, fixture.warp, profile)
    assert est1 == est2
    assert est1.shift_sec == pytest.approx(-0.040, abs=0.002)


def test_latency_alias_marks_uncertain_at_120bpm() -> None:
    """At 120 BPM the +85 ms alias sits inside the band -> flagged, not applied.

    Design 6.3: competing minima -> no silent auto-apply + ReviewIssue. The
    unshifted quantization still recovers the grid because the 0.08 ql
    residual is inside the candidate window.
    """
    fixture = fx.quarters_latency40()
    est = estimate_alignment_shift(fixture.events, fixture.warp, QuantizationProfile())
    assert est.uncertain  # perfect periodic alias at +85 ms
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    diag = alts[0].diagnostics
    assert diag.alignment_shift_sec == 0.0  # not auto-applied
    assert "beat_alignment_uncertain" in diag.review_reasons
    assert _onsets(alts[0]) == _expected(fixture)


def test_latency_applied_when_unique_at_60bpm() -> None:
    """At 60 BPM the alias falls outside +-120 ms -> -40 ms applied cleanly."""
    fixture = fx.quarters_latency40_slow()
    est = estimate_alignment_shift(fixture.events, fixture.warp, QuantizationProfile())
    assert est.shift_sec == pytest.approx(-0.040, abs=0.002)
    assert not est.uncertain
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert alts[0].diagnostics.alignment_shift_sec == pytest.approx(-0.040, abs=0.002)
    assert alts[0].diagnostics.review_reasons == ()
    assert _onsets(alts[0]) == _expected(fixture)


def test_alignment_search_disabled_via_profile() -> None:
    fixture = fx.quarters_latency40_slow()
    profile = QuantizationProfile(max_alignment_shift_sec=0.0)
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map, profile=profile)
    assert alts[0].diagnostics.alignment_shift_sec == 0.0
    assert _onsets(alts[0]) == _expected(fixture)


# --- tempo change via explicit BeatMap (required fixture) -----------------------------


def test_tempo_change_beatmap_exact() -> None:
    fixture = fx.tempo_change_beatmap()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert _onsets(alts[0]) == _expected(fixture)


# --- determinism (acceptance) ----------------------------------------------------------


def test_dp_deterministic() -> None:
    fixture = fx.quarters_jitter50()
    first = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    second = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert first == second
    for a, b in zip(first, second, strict=True):
        assert a.total_cost == b.total_cost
        assert [n.onset_ql for n in a.notes] == [n.onset_ql for n in b.notes]


# --- top-K alternatives (acceptance: top-3 returnable) ----------------------------------


def test_top3_alternatives_returned() -> None:
    fixture = fx.quarters_exact()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert len(alts) == 3  # K=3 default (design 19)
    assert [a.rank for a in alts] == [1, 2, 3]
    costs = [a.total_cost for a in alts]
    assert costs == sorted(costs)
    # alternatives are distinct hypotheses about the same canonical notes
    assert len({tuple(n.onset_ql for n in a.notes) for a in alts}) == 3
    for alt in alts:
        assert [n.canonical_note_id for n in alt.notes] == [
            f"sn-{i + 1:06d}" for i in range(len(fixture.events))
        ]


def test_alternative_diagnostics_costs() -> None:
    fixture = fx.quarters_exact()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert alts[0].diagnostics.path_cost == alts[0].total_cost
    assert alts[0].diagnostics.alternative_cost == alts[1].total_cost
    assert alts[-1].diagnostics.alternative_cost is None
    assert alts[0].diagnostics.meter == "4/4"
    assert alts[0].diagnostics.min_note_value_ql == Fraction(1, 4)
    assert alts[0].diagnostics.triplet_policy is TripletPolicy.AUTO


# --- documented tie-break (design 44) ----------------------------------------------------


def test_tie_break_prefers_earlier_position() -> None:
    """An onset exactly between two grid points resolves to the earlier one.

    Documented path order: (1) lower total cost, then (2) lexicographic
    Fraction order of positions — so the tied midpoint picks 0 over 1/4.
    """
    note = NormalizedNote(
        source_id=RawNoteEventId("rne-000001"),
        pitch_midi=60,
        onset_ql=0.125,
        offset_ql=0.6,
    )
    alts = quantize_normalized([note])
    assert alts[0].notes[0].onset_ql == Fraction(0)
    # the tied alternative is returned as rank 2 — ambiguity is kept, not hidden
    assert alts[1].notes[0].onset_ql == Fraction(1, 4)
    assert alts[0].total_cost == alts[1].total_cost


# --- monotonic output guarantee (acceptance) ----------------------------------------------


@pytest.mark.parametrize(
    "make", fx.ALL_FIXTURES, ids=[m().name for m in fx.ALL_FIXTURES]
)
def test_all_alternatives_strictly_monotonic(make: FixtureFactory) -> None:
    fixture = make()
    for alt in quantize_events(fixture.events, fixture.warp, fixture.meter_map):
        positions = [n.onset_ql for n in alt.notes]
        assert all(b > a for a, b in pairwise(positions))


def test_infeasible_input_falls_back_monotonic() -> None:
    """Several notes collapsing to one candidate -> repaired + review reason."""
    notes = tuple(
        NormalizedNote(
            source_id=RawNoteEventId(f"rne-{i + 1:06d}"),
            pitch_midi=60,
            onset_ql=-0.60,  # only candidate is position 0 for all notes
            offset_ql=-0.5,
        )
        for i in range(3)
    )
    alts = quantize_normalized(notes)
    positions = [n.onset_ql for n in alts[0].notes]
    assert all(b > a for a, b in pairwise(positions))
    assert "overlapping_candidates" in alts[0].diagnostics.review_reasons


# --- IOI cost toggle (acceptance: disableable for ablation) --------------------------------


def test_ioi_cost_recovers_consistent_shift() -> None:
    """Design 10.2: IOI keeps the pair's interval -> [0, 1] not [0, 5/4].

    QNT-003: with joint duration/rest realization enabled, the notation
    complexity term alone also prefers [0, 1] — a 5/4 note span needs an
    ugly tie across a beat — so the IOI term's isolated contribution is
    shown through the timing-only (onset-only) ablation path.
    """
    fixture = fx.ioi_pair_fixture()
    profile = QuantizationProfile()
    with_ioi = quantize_events(fixture.events, fixture.warp, profile=profile)
    no_ioi_profile = replace(profile, weights=replace(profile.weights, ioi=0.0))
    without_ioi = quantize_events(
        fixture.events,
        fixture.warp,
        profile=no_ioi_profile,
        realize_durations=False,
    )
    assert _onsets(with_ioi[0]) == [Fraction(0), Fraction(1)]
    assert _onsets(without_ioi[0]) == [Fraction(0), Fraction(5, 4)]
    # Realization on: the span-notation cost recovers [0, 1] without IOI.
    realized_no_ioi = quantize_events(
        fixture.events, fixture.warp, profile=no_ioi_profile
    )
    assert _onsets(realized_no_ioi[0]) == [Fraction(0), Fraction(1)]


# --- misc contract --------------------------------------------------------------------------


def test_empty_input() -> None:
    assert quantize_normalized(()) == ()
    assert quantize_events((), fx.quarters_exact().warp) == ()


def test_raw_event_durations_never_mutated() -> None:
    """Acceptance: raw evidence is immutable; realized notes never overlap."""
    fixture = fx.quarters_jitter50()
    before = [(e.onset_sec, e.offset_sec) for e in fixture.events]
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    after = [(e.onset_sec, e.offset_sec) for e in fixture.events]
    assert before == after
    # realized rule: notation tiles each note span; a note end never crosses
    # the next onset (monophonic rule, design 27); rests fill the gaps.
    for alt in alts:
        assert all(n.notation is not None for n in alt.notes)
        for cur, nxt in pairwise(alt.notes):
            assert cur.end_ql <= nxt.onset_ql


def test_provisional_output_in_timing_only_ablation() -> None:
    """``realize_durations=False`` keeps the QNT-002 provisional contract."""
    fixture = fx.quarters_jitter50()
    alts = quantize_events(
        fixture.events, fixture.warp, fixture.meter_map, realize_durations=False
    )
    assert alts
    for alt in alts:
        assert all(n.notation is None for n in alt.notes)
        assert alt.rests == ()
        for cur, nxt in pairwise(alt.notes):
            assert cur.end_ql == nxt.onset_ql


def test_unsorted_input_sorted_deterministically() -> None:
    fixture = fx.quarters_exact()
    reversed_events = tuple(reversed(fixture.events))
    alts = quantize_events(reversed_events, fixture.warp, fixture.meter_map)
    assert _onsets(alts[0]) == _expected(fixture)
