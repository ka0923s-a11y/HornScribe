"""Onset candidate lattice (QUANTIZER_DESIGN.md section 8).

For each normalized note onset ``x_i`` (float quarterLength, still raw
evidence) the quantizer generates a small set of candidate grid positions
``C_i``. The *binary* lattice is always enabled: positions are exact
multiples ``k * step`` of the profile's ``min_note_value_ql`` (default
``1/4 ql`` = sixteenth note, design 8.1). QNT-005 adds the *triplet* grid
family: positions ``b + k/3`` inside evidence-gated
:class:`~hornscribe.rhythm.triplet.TripletRegion` beats of simple meters
(design 8.2, 17.2). Compound-meter ternary subdivisions are native meter
structure and never appear as triplet candidates (design 7.3).

Candidate selection rule (design 8.3):

* keep grid points inside ``candidate_window_ql`` of the observed onset —
  the window is in musical time so it does not depend on tempo;
* keep at most ``max_candidates_per_grid`` of them, nearest first (the
  "nearest 2-3 points per enabled grid family" starting heuristic);
* positions are clamped to ``>= min_position_ql`` — a score note cannot
  start before the score origin (or the meter map's covered origin);
* if the window filter left nothing (an onset far before position ``0``),
  the single nearest grid point is kept so every note always has at least
  one candidate.

All committed positions are exact :class:`~fractions.Fraction`; distances to
the observed onset are ``float`` evidence values used only inside costs.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from dataclasses import dataclass
from enum import Enum
from fractions import Fraction
from typing import TYPE_CHECKING

from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import NormalizedNote
from hornscribe.rhythm.profile import QuantizationProfile

if TYPE_CHECKING:
    # Cycle guard: triplet.py imports grid_distance_ql from this module.
    from hornscribe.rhythm.triplet import TripletRegion

#: Inclusion tolerance for float boundary comparisons (design 8.3).
_WINDOW_EPSILON = 1e-9

#: Default cap on candidates per enabled grid family (design 8.3: "nearest
#: 2-3 points per enabled grid family").
DEFAULT_MAX_CANDIDATES_PER_GRID = 3


class CandidateGrid(Enum):
    """Grid family a candidate position was drawn from (design 8, 18).

    The enum doubles as the DP *grid mode* (design 18): every committed
    position carries the family it came from so mode-switch cost and
    grid-aware tie-breaks have a stable vocabulary.
    """

    BINARY = "binary"
    TRIPLET = "triplet"


@dataclass(frozen=True)
class OnsetCandidate:
    """One possible quantized onset position for a note (design 8).

    ``position_ql`` is exact — candidates are always grid multiples, never
    float-derived. ``distance_ql`` is the float ``|position - onset|``
    residual used by onset costs.
    """

    position_ql: Fraction
    grid: CandidateGrid
    distance_ql: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "position_ql", as_exact_fraction(self.position_ql, name="position_ql")
        )
        if self.position_ql < 0:
            raise ValueError(f"candidate position_ql must be >= 0, got {self.position_ql}")
        if not isinstance(self.grid, CandidateGrid):
            raise TypeError(f"grid must be a CandidateGrid, got {self.grid!r}")
        if not math.isfinite(self.distance_ql) or self.distance_ql < 0:
            raise ValueError(f"distance_ql must be finite and >= 0, got {self.distance_ql!r}")


def nearest_grid_index(x_ql: float, step_ql: Fraction) -> int:
    """Index ``k`` of the nearest multiple ``k * step_ql`` to ``x_ql``.

    Ties (``x_ql`` exactly between two grid points) resolve to the *earlier*
    grid point — the deterministic order used throughout HSQ (design 44:
    lexical Fraction order prefers smaller positions). The index may be
    negative; position validity is the caller's concern.
    """
    step = float(step_ql)
    if step <= 0 or not math.isfinite(step) or not math.isfinite(x_ql):
        raise ValueError(f"invalid snap: x_ql={x_ql!r}, step_ql={step_ql!r}")
    lo = math.floor(x_ql / step)
    d_lo = x_ql - lo * step
    d_hi = (lo + 1) * step - x_ql
    return lo if d_lo <= d_hi else lo + 1


def grid_distance_ql(x_ql: float, step_ql: Fraction) -> float:
    """Distance from ``x_ql`` to the nearest ``step_ql`` multiple.

    The mathematical grid extends below zero: this measures *metrical*
    distance (how far the observation sits from any lattice point), used by
    the global alignment-shift search (design 6.3) where candidate validity
    is irrelevant.
    """
    k = nearest_grid_index(x_ql, step_ql)
    return abs(x_ql - k * float(step_ql))


def snap_to_grid_ql(x_ql: float, step_ql: Fraction, *, minimum: Fraction = Fraction(0)) -> Fraction:
    """Nearest ``step_ql`` multiple as an exact Fraction, clamped to ``minimum``.

    Ties resolve to the earlier grid point (same rule as
    :func:`nearest_grid_index`).
    """
    pos = Fraction(nearest_grid_index(x_ql, step_ql)) * step_ql
    return max(pos, minimum)


def generate_onset_candidates(
    note: NormalizedNote,
    profile: QuantizationProfile,
    *,
    max_candidates_per_grid: int = DEFAULT_MAX_CANDIDATES_PER_GRID,
    min_position_ql: Fraction = Fraction(0),
    triplet_regions: tuple[TripletRegion, ...] = (),
) -> tuple[OnsetCandidate, ...]:
    """Onset candidates for one normalized note (design 8).

    Binary positions are the exact multiples of ``profile.min_note_value_ql``
    inside ``[x - window, x + window]`` (clamped to ``>= min_position_ql``).
    When the onset falls inside an enabled :class:`TripletRegion`, the
    region's triplet points ``b + k/3`` (``k = 0, 1, 2`` — the end point is
    the next beat and belongs to the binary grid) are added as
    :attr:`CandidateGrid.TRIPLET` candidates (design 8.2). A beat-start
    position therefore exists once per family — both labels are kept so the
    DP can track grid mode honestly.

    Each family is ranked by ``(distance, position)`` and capped at
    ``max_candidates_per_grid``; the merged result is sorted by position —
    the canonical iteration order for the DP.

    ``min_position_ql`` defaults to the score origin ``0``; the quantizer
    passes the meter map's first segment start so no candidate can land
    before the covered timeline (design 8.3's ``>= 0`` clamp, extended in
    QNT-004 to meter-map coverage).
    """
    if max_candidates_per_grid < 1:
        raise ValueError(
            f"max_candidates_per_grid must be >= 1, got {max_candidates_per_grid!r}"
        )
    floor = as_exact_fraction(min_position_ql, name="min_position_ql")
    if floor < 0:
        raise ValueError(f"min_position_ql must be >= 0, got {floor}")
    step = profile.min_note_value_ql
    step_f = float(step)
    window = float(profile.candidate_window_ql)
    x = note.onset_ql

    # First grid index at/above the floor (the floor need not be a grid
    # multiple itself): k_floor * step >= floor.
    k_floor = int(-((-floor) // step))
    k_lo = max(k_floor, math.floor((x - window) / step_f))
    k_hi = max(k_floor, math.ceil((x + window) / step_f))
    points = [
        Fraction(k) * step
        for k in range(k_lo, k_hi + 1)
        if abs(k * step_f - x) <= window + _WINDOW_EPSILON
    ]
    if not points:
        # Degenerate case (e.g. onset far below the floor): always keep the
        # nearest valid grid point so every note has at least one candidate.
        points = [snap_to_grid_ql(x, step, minimum=Fraction(k_floor) * step)]

    candidates = [
        OnsetCandidate(
            position_ql=pos,
            grid=CandidateGrid.BINARY,
            distance_ql=abs(float(pos) - x),
        )
        for pos in points
    ]

    # Nearest-first ranking; ties prefer the earlier position (design 44).
    candidates.sort(key=lambda c: (c.distance_ql, c.position_ql))
    kept = candidates[:max_candidates_per_grid]

    if triplet_regions:
        starts = [r.start_ql for r in triplet_regions]
        i = bisect_right(starts, x) - 1
        if i >= 0 and x < float(triplet_regions[i].end_ql):
            region = triplet_regions[i]
            trip = [
                OnsetCandidate(
                    position_ql=pos,
                    grid=CandidateGrid.TRIPLET,
                    distance_ql=abs(float(pos) - x),
                )
                for pos in region.third_positions_ql[:-1]
                if pos >= floor and abs(float(pos) - x) <= window + _WINDOW_EPSILON
            ]
            trip.sort(key=lambda c: (c.distance_ql, c.position_ql))
            kept.extend(trip[:max_candidates_per_grid])

    # Per-family caps above; merged order is by position so the DP iterates
    # candidates canonically (design 44).
    kept.sort(key=lambda c: c.position_ql)
    return tuple(kept)
