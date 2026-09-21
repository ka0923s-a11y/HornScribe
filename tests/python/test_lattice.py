"""QNT-002: binary candidate lattice (QUANTIZER_DESIGN.md section 8)."""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.ids import RawNoteEventId
from hornscribe.rhythm import (
    CandidateGrid,
    NormalizedNote,
    OnsetCandidate,
    QuantizationProfile,
    generate_onset_candidates,
    grid_distance_ql,
    nearest_grid_index,
    snap_to_grid_ql,
)


def _note(onset_ql: float, offset_ql: float | None = None) -> NormalizedNote:
    return NormalizedNote(
        source_id=RawNoteEventId("rne-000001"),
        pitch_midi=60,
        onset_ql=onset_ql,
        offset_ql=offset_ql if offset_ql is not None else onset_ql + 0.5,
    )


# --- grid helpers -----------------------------------------------------------------


def test_nearest_grid_index_ties_resolve_earlier() -> None:
    """Documented tie-break: exact midpoints snap to the earlier grid point."""
    step = Fraction(1, 4)
    assert nearest_grid_index(0.10, step) == 0
    assert nearest_grid_index(0.125, step) == 0  # tie -> earlier
    assert nearest_grid_index(0.13, step) == 1
    assert nearest_grid_index(-0.1, step) == 0
    assert nearest_grid_index(-0.13, step) == -1


def test_snap_to_grid_clamps_at_zero() -> None:
    step = Fraction(1, 4)
    assert snap_to_grid_ql(-0.30, step) == Fraction(0)  # minimum clamps
    assert snap_to_grid_ql(0.13, step) == Fraction(1, 4)
    assert isinstance(snap_to_grid_ql(0.13, step), Fraction)


def test_grid_distance_ql() -> None:
    step = Fraction(1, 4)
    assert grid_distance_ql(0.0, step) == 0.0
    assert grid_distance_ql(0.10, step) == pytest.approx(0.10)
    assert grid_distance_ql(0.375, step) == pytest.approx(0.125)  # midpoint
    assert grid_distance_ql(-0.30, step) == pytest.approx(0.05)  # math grid, unclamped


# --- candidate generation (design 8.1, 8.3) ----------------------------------------


def test_candidates_include_nearest_and_neighbors() -> None:
    """Design 8.1: nearest grid point plus previous/next inside the window."""
    profile = QuantizationProfile()  # step 1/4, window 0.35
    candidates = generate_onset_candidates(_note(0.10), profile)
    positions = [c.position_ql for c in candidates]
    assert positions == [Fraction(0), Fraction(1, 4)]
    assert all(c.grid is CandidateGrid.BINARY for c in candidates)


def test_candidates_include_far_point_inside_window() -> None:
    """0.15 -> 0.5 is exactly 0.35 away: the window boundary is inclusive."""
    profile = QuantizationProfile()
    positions = [c.position_ql for c in generate_onset_candidates(_note(0.15), profile)]
    assert positions == [Fraction(0), Fraction(1, 4), Fraction(1, 2)]


def test_candidates_respect_window() -> None:
    profile = QuantizationProfile()
    positions = [c.position_ql for c in generate_onset_candidates(_note(0.4), profile)]
    # 0.75 is 0.35 away (inside); 0.0 is 0.4 away (outside)
    assert positions == [Fraction(1, 4), Fraction(1, 2), Fraction(3, 4)]


def test_candidates_exact_fractions_and_sorted() -> None:
    profile = QuantizationProfile()
    candidates = generate_onset_candidates(_note(1.13), profile)
    assert all(isinstance(c.position_ql, Fraction) for c in candidates)
    positions = [c.position_ql for c in candidates]
    assert positions == sorted(positions)


def test_candidates_clamped_nonnegative() -> None:
    profile = QuantizationProfile()
    positions = [c.position_ql for c in generate_onset_candidates(_note(0.05), profile)]
    assert all(p >= 0 for p in positions)
    assert Fraction(0) in positions


def test_candidates_fallback_when_window_empty() -> None:
    """Onsets before the score origin still get one nearest candidate."""
    profile = QuantizationProfile()
    candidates = generate_onset_candidates(_note(-0.60), profile)
    assert [c.position_ql for c in candidates] == [Fraction(0)]


def test_candidates_distance_field() -> None:
    profile = QuantizationProfile()
    candidates = generate_onset_candidates(_note(0.10), profile)
    by_pos = {c.position_ql: c.distance_ql for c in candidates}
    assert by_pos[Fraction(0)] == pytest.approx(0.10)
    assert by_pos[Fraction(1, 4)] == pytest.approx(0.15)


def test_candidates_max_per_grid_cap() -> None:
    """Design 8.3: at most ~3 nearest points per enabled grid family."""
    profile = QuantizationProfile(min_note_value_ql=Fraction(1, 8))
    candidates = generate_onset_candidates(_note(0.31), profile)
    assert len(candidates) == 3
    assert [c.position_ql for c in candidates] == [
        Fraction(1, 8),
        Fraction(1, 4),
        Fraction(3, 8),
    ]


def test_candidate_validation() -> None:
    with pytest.raises(ValueError, match=">= 0"):
        OnsetCandidate(position_ql=Fraction(-1), grid=CandidateGrid.BINARY, distance_ql=0.1)
    with pytest.raises(ValueError, match="distance_ql"):
        OnsetCandidate(position_ql=Fraction(0), grid=CandidateGrid.BINARY, distance_ql=-1.0)
