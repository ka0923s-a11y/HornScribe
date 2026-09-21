"""QNT-002: naive baselines B0/B1 (QUANTIZER_DESIGN.md 3.1, 37)."""

from __future__ import annotations

from fractions import Fraction
from itertools import pairwise

import pytest

import rhythm_fixtures as fx
from hornscribe.domain.ids import RawNoteEventId
from hornscribe.rhythm import (
    BASELINE_B0_GRID_QL,
    NormalizedNote,
    QuantizationProfile,
    normalize_to_score_time,
    snap_candidate_lattice,
    snap_nearest_grid,
)


def _normalized(fixture: fx.RhythmFixture):
    return normalize_to_score_time(fixture.events, fixture.warp)


def _note(onset_ql: float, event_id: str = "rne-000001") -> NormalizedNote:
    return NormalizedNote(
        source_id=RawNoteEventId(event_id),
        pitch_midi=60,
        onset_ql=onset_ql,
        offset_ql=onset_ql + 0.4,
    )


# --- B0 nearest-16th ------------------------------------------------------------------


def test_b0_snaps_exact_grid() -> None:
    fixture = fx.quarters_exact()
    out = snap_nearest_grid(_normalized(fixture))
    assert [n.onset_ql for n in out] == list(fixture.expected_onsets_ql)


def test_b0_recovers_jittered_grid() -> None:
    for make in (fx.quarters_jitter20, fx.quarters_jitter50):
        fixture = make()
        out = snap_nearest_grid(_normalized(fixture))
        assert [n.onset_ql for n in out] == list(fixture.expected_onsets_ql)


def test_b0_fixed_16th_grid_regardless_of_profile() -> None:
    """B0 is always the sixteenth grid — the fixed naive reference."""
    assert Fraction(1, 4) == BASELINE_B0_GRID_QL
    out = snap_nearest_grid([_note(0.13)])
    assert out[0].onset_ql == Fraction(1, 4)


def test_b0_tie_snaps_earlier() -> None:
    """Documented tie-break matching HSQ: midpoints go to the earlier point."""
    out = snap_nearest_grid([_note(0.125)])
    assert out[0].onset_ql == Fraction(0)


def test_b0_repairs_nonmonotonic_snap() -> None:
    """Independent snaps that collide are nudged forward, preserving order."""
    notes = (
        _note(0.10, "rne-000001"),  # snaps to 0
        _note(0.10, "rne-000002"),  # also snaps to 0 -> repaired to 1/4
    )
    out = snap_nearest_grid(notes)
    positions = [n.onset_ql for n in out]
    assert positions == [Fraction(0), Fraction(1, 4)]
    assert all(b > a for a, b in pairwise(positions))


def test_b0_provisional_durations() -> None:
    fixture = fx.quarters_exact()
    out = snap_nearest_grid(_normalized(fixture))
    for cur, nxt in pairwise(out):
        assert cur.duration_ql == nxt.onset_ql - cur.onset_ql
    assert out[-1].duration_ql > 0


# --- B1 nearest binary candidate grid ---------------------------------------------------


def test_b1_default_profile_matches_b0_grid() -> None:
    """With the default 1/4-ql minimum, B1's lattice is the B0 grid."""
    fixture = fx.quarters_jitter50()
    normalized = _normalized(fixture)
    assert [n.onset_ql for n in snap_candidate_lattice(normalized)] == [
        n.onset_ql for n in snap_nearest_grid(normalized)
    ]


def test_b1_respects_profile_min_value() -> None:
    """B1 follows the configured binary grid (e.g. eighth notes)."""
    profile = QuantizationProfile(min_note_value_ql=Fraction(1, 2))
    out = snap_candidate_lattice([_note(0.35)], profile)
    assert out[0].onset_ql == Fraction(1, 2)


def test_b1_fails_where_hsq_recovers() -> None:
    """The IOI pair fixture: independent snapping picks the wrong candidate."""
    fixture = fx.ioi_pair_fixture()
    out = snap_candidate_lattice(_normalized(fixture))
    assert [n.onset_ql for n in out] == [Fraction(0), Fraction(5, 4)]  # != expected


def test_baselines_deterministic_and_monotonic() -> None:
    fixture = fx.quarters_jitter50()
    normalized = _normalized(fixture)
    for snap in (snap_nearest_grid, snap_candidate_lattice):
        first = snap(normalized)
        second = snap(normalized)
        assert first == second
        positions = [n.onset_ql for n in first]
        assert all(b > a for a, b in pairwise(positions))
        assert all(isinstance(p, Fraction) for p in positions)


def test_baselines_empty_input() -> None:
    assert snap_nearest_grid(()) == ()
    assert snap_candidate_lattice(()) == ()


def test_b0_rejects_bad_grid() -> None:
    with pytest.raises(ValueError, match="grid_ql"):
        snap_nearest_grid([_note(0.1)], grid_ql=Fraction(0))
