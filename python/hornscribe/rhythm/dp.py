"""Deterministic top-K onset dynamic programming (QUANTIZER_DESIGN.md 11, 19, 32).

Each note's candidate set ``C_i`` forms one layer of a layered DAG; edges run
only between adjacent layers and only *strictly forward* — ``curr.position <=
prev.position`` transitions are rejected, which is what makes every emitted
path monotonic by construction (design 32, step 5).

Node cost::

    onset_cost(curr, note_i)

Edge cost ``prev -> curr``::

    ioi_cost(prev, curr, note_{i-1}, note_i)
    + mode_switch_cost(prev.grid, curr.grid)
      (QNT-005 grid mode, design 18 — one binary<->triplet switch per
      boundary prevents one-note grid flicker)
    + interval realization cost of note_{i-1} over [prev, curr)
      (QNT-003 joint note/rest evaluation, design 12/33 — present only
      when a SpanRealizer is supplied; skipped in onset-only mode)

A transition whose interval cannot be written at all (mixed binary/triplet
endpoints that no atom vocabulary tiles) is skipped — the edge simply does
not exist.

The last note has no successor transition, so its phrase-end interval
(``next_onset=None``) is realized once per final-layer candidate at
finalization (design 32, step 5).

Each node keeps the ``K = profile.k_best`` best partial paths ending there
("k-best per state", design 19); the final layer is merged into the global
top-K. Path order is the documented deterministic tie-break (design 44):

1. lower total cost;
2. fewer written symbols (atoms) — vacuous in onset-only mode;
3. fewer tuplet groups — vacuous until triplet atoms exist;
4. fewer ties — vacuous in onset-only mode;
5. earlier/simpler grid family — binary before triplet at equal cost;
6. lexicographic :class:`~fractions.Fraction` order of the position
   sequence — the earlier differing position wins.

No randomness anywhere: identical (notes, candidates, profile) always yields
an identical result.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise

from hornscribe.rhythm.contracts import NormalizedNote
from hornscribe.rhythm.costs import confidence_weight, huber, ioi_cost, onset_cost
from hornscribe.rhythm.lattice import CandidateGrid, OnsetCandidate
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.realize import IntervalRealization, SpanRealizer

#: Deterministic "earlier/simpler grid family" order for tie-breaks (44).
_GRID_ORDER: dict[CandidateGrid, int] = {
    CandidateGrid.BINARY: 0,
    CandidateGrid.TRIPLET: 1,
}


@dataclass(frozen=True)
class OnsetPath:
    """One ranked onset hypothesis: an exact position per input note.

    ``realizations`` carries the chosen per-interval note/rest decomposition
    (QNT-003): entry ``i`` realizes ``[positions[i], positions[i+1])`` and the
    last entry is the phrase-end interval. It stays empty in onset-only mode
    (no ``SpanRealizer``) — the caller then emits provisional durations.
    ``grids`` records the grid family each committed position came from
    (QNT-005 grid mode); empty means "all binary" for legacy/fallback paths.
    """

    positions: tuple[Fraction, ...]
    """Quantized onset per input note, strictly increasing, exact Fractions."""
    cost: float
    """Total onset + IOI + mode-switch (+ realization) cost accumulated."""
    realizations: tuple[IntervalRealization, ...] = ()
    grids: tuple[CandidateGrid, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "positions", tuple(self.positions))
        object.__setattr__(self, "realizations", tuple(self.realizations))
        object.__setattr__(self, "grids", tuple(self.grids))
        for pos in self.positions:
            if not isinstance(pos, Fraction):
                raise TypeError(f"positions must be exact Fractions, got {pos!r}")
        for prev, curr in pairwise(self.positions):
            if curr <= prev:
                raise ValueError(
                    f"onset path must be strictly increasing: {prev} !< {curr}"
                )
        if self.realizations and len(self.realizations) != len(self.positions):
            raise ValueError(
                "realizations must cover one interval per position: "
                f"{len(self.realizations)} != {len(self.positions)}"
            )
        if self.grids and len(self.grids) != len(self.positions):
            raise ValueError(
                "grids must cover one entry per position: "
                f"{len(self.grids)} != {len(self.positions)}"
            )

    @property
    def tuplet_group_count(self) -> int:
        """Visual tuplet groups along the path (design 7.3/44).

        Per-interval counts minus the runs that continue a group started in
        the previous interval — flagged on
        :attr:`IntervalRealization.triplet_group_continuation` (the flag can
        only fire for intervals with a predecessor).
        """
        groups = 0
        for i, rlz in enumerate(self.realizations):
            groups += rlz.tuplet_group_count
            if i >= 1 and rlz.triplet_group_continuation:
                groups -= 1
        return groups


@dataclass(frozen=True)
class _PathState:
    """Partial path ending at one candidate node."""

    cost: float
    positions: tuple[Fraction, ...]
    grids: tuple[int, ...]
    """Grid-family ordinal per committed position (design 18, 44)."""
    symbols: int = 0
    """Written atoms accumulated by realized intervals so far (design 44)."""
    tuplets: int = 0
    """Tuplet groups accumulated by realized intervals so far (design 44)."""
    ties: int = 0
    """Ties accumulated by realized intervals so far (design 44)."""
    realizations: tuple[IntervalRealization, ...] = ()


def _path_key(
    state: _PathState,
) -> tuple[float, int, int, int, tuple[int, ...], tuple[Fraction, ...]]:
    """Deterministic path order (design 44): cost, symbols, tuplets, ties,
    earlier/simpler grid family, then lexicographic positions."""
    return (
        state.cost,
        state.symbols,
        state.tuplets,
        state.ties,
        state.grids,
        state.positions,
    )


def _top_k(states: list[_PathState], k: int) -> list[_PathState]:
    """The ``k`` best states under the documented tie-break order."""
    return sorted(states, key=_path_key)[:k]


def kbest_onset_paths(
    notes: tuple[NormalizedNote, ...],
    candidates: tuple[tuple[OnsetCandidate, ...], ...],
    profile: QuantizationProfile,
    realizer: SpanRealizer | None = None,
) -> tuple[OnsetPath, ...]:
    """Global top-K onset paths via layered k-best DP (design 11, 19, 32).

    ``notes`` must already be onset-sorted and ``candidates[i]`` the
    candidate lattice for ``notes[i]``. Returns up to ``profile.k_best``
    paths, best first. An empty tuple means *no strictly increasing path
    exists* (pathological input — e.g. several notes whose only candidate is
    position ``0``); the caller decides how to repair it.

    When ``realizer`` is given, every transition ``prev -> curr`` adds the
    best joint note+rest realization cost of the interval
    ``[prev, curr)`` (design 12/33), and each emitted path carries its chosen
    :class:`IntervalRealization` sequence for output assembly.
    """
    if len(notes) != len(candidates):
        raise ValueError(
            f"notes/candidates length mismatch: {len(notes)} != {len(candidates)}"
        )
    if not notes:
        return ()
    k = profile.k_best
    weights = profile.weights

    # Layer 0: node cost only — the first note's grid choice is free (no
    # incoming edge to switch from). One single-state list per candidate.
    layer: list[list[_PathState]] = [
        [
            _PathState(
                cost=onset_cost(c, notes[0], profile),
                positions=(c.position_ql,),
                grids=(_GRID_ORDER[c.grid],),
            )
        ]
        for c in candidates[0]
    ]

    for i in range(1, len(notes)):
        next_layer: list[list[_PathState]] = []
        for curr in candidates[i]:
            pool: list[_PathState] = []
            curr_cost = onset_cost(curr, notes[i], profile)
            for prev, prev_states in zip(candidates[i - 1], layer, strict=True):
                if curr.position_ql <= prev.position_ql:
                    continue  # monotonic transition rule (design 32)
                transition = ioi_cost(
                    prev.position_ql, curr.position_ql, notes[i - 1], notes[i], profile
                )
                if prev.grid != curr.grid:
                    transition += weights.mode_switch
                interval: IntervalRealization | None = None
                interval_cost = 0.0
                interval_groups = 0
                if realizer is not None:
                    interval = realizer.interval(
                        prev.position_ql, curr.position_ql, notes[i - 1]
                    )
                    if interval is None:
                        continue  # interval cannot be written — no such edge
                    interval_cost = interval.cost
                    interval_groups = interval.tuplet_group_count
                    if i >= 2 and interval.triplet_group_continuation:
                        # The first triplet run continues the previous
                        # interval's visual group — do not charge it twice.
                        interval_cost -= weights.tuplet_group
                        interval_groups -= 1
                for state in prev_states:
                    pool.append(
                        _PathState(
                            cost=state.cost + curr_cost + transition + interval_cost,
                            positions=(*state.positions, curr.position_ql),
                            grids=(*state.grids, _GRID_ORDER[curr.grid]),
                            symbols=state.symbols
                            + (interval.symbol_count if interval is not None else 0),
                            tuplets=state.tuplets + interval_groups,
                            ties=state.ties
                            + (interval.tie_count if interval is not None else 0),
                            realizations=(*state.realizations, interval)
                            if interval is not None
                            else state.realizations,
                        )
                    )
            next_layer.append(_top_k(pool, k))
        layer = next_layer

    if realizer is not None:
        # Phrase-end interval for the last note, once per final candidate
        # (it depends only on the candidate position, not on the path).
        tail_by_pos: dict[Fraction, IntervalRealization | None] = {}
        for cand in candidates[-1]:
            tail_by_pos[cand.position_ql] = realizer.interval(
                cand.position_ql, None, notes[-1]
            )
        finalized: list[list[_PathState]] = []
        for cand, states in zip(candidates[-1], layer, strict=True):
            tail = tail_by_pos[cand.position_ql]
            if tail is None:
                continue  # no writable phrase-end interval for this candidate
            discount = (
                weights.tuplet_group
                if tail.triplet_group_continuation and len(notes) >= 2
                else 0.0
            )
            finalized.append(
                [
                    _PathState(
                        cost=state.cost + tail.cost - discount,
                        positions=state.positions,
                        grids=state.grids,
                        symbols=state.symbols + tail.symbol_count,
                        tuplets=state.tuplets
                        + tail.tuplet_group_count
                        - int(bool(discount)),
                        ties=state.ties + tail.tie_count,
                        realizations=(*state.realizations, tail),
                    )
                    for state in states
                ]
            )
        layer = finalized

    final = _top_k([state for states in layer for state in states], k)
    grid_by_ordinal = {v: k2 for k2, v in _GRID_ORDER.items()}
    return tuple(
        OnsetPath(
            positions=s.positions,
            cost=s.cost,
            realizations=s.realizations,
            grids=tuple(grid_by_ordinal[g] for g in s.grids),
        )
        for s in final
    )


def evaluate_onset_path_cost(
    positions: tuple[Fraction, ...],
    notes: tuple[NormalizedNote, ...],
    profile: QuantizationProfile,
) -> float:
    """Rescore an existing position sequence under the onset+IOI objective.

    Used for paths not produced by the DP itself (e.g. the monotonic-repair
    fallback) so alternatives still carry an honest comparable cost. The
    caller adds realization costs separately when they apply.
    """
    if len(positions) != len(notes):
        raise ValueError(
            f"positions/notes length mismatch: {len(positions)} != {len(notes)}"
        )
    if not positions:
        return 0.0
    total = 0.0
    for pos, note in zip(positions, notes, strict=True):
        residual = (float(pos) - note.onset_ql) / profile.sigma_onset_ql
        total += (
            confidence_weight(note.confidence)
            * profile.weights.onset
            * huber(residual, profile.huber_k)
        )
    for i in range(1, len(positions)):
        quantized_ioi = float(positions[i] - positions[i - 1])
        observed_ioi = notes[i].onset_ql - notes[i - 1].onset_ql
        residual = (quantized_ioi - observed_ioi) / profile.sigma_ioi_ql
        total += profile.weights.ioi * huber(residual, profile.huber_k)
    return total
