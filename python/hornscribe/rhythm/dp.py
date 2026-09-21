"""Deterministic top-K onset dynamic programming (QUANTIZER_DESIGN.md 11, 19, 32).

Each note's candidate set ``C_i`` forms one layer of a layered DAG; edges run
only between adjacent layers and only *strictly forward* — ``curr.position <=
prev.position`` transitions are rejected, which is what makes every emitted
path monotonic by construction (design 32, step 5).

Node cost::

    onset_cost(curr, note_i)

Edge cost ``prev -> curr``::

    ioi_cost(prev, curr, note_{i-1}, note_i)
    + interval realization cost of note_{i-1} over [prev, curr)
      (QNT-003 joint note/rest evaluation, design 12/33 — present only
      when a SpanRealizer is supplied; skipped in onset-only mode)

The last note has no successor transition, so its phrase-end interval
(``next_onset=None``) is realized once per final-layer candidate at
finalization (design 32, step 5).

Each node keeps the ``K = profile.k_best`` best partial paths ending there
("k-best per state", design 19); the final layer is merged into the global
top-K. Path order is the documented deterministic tie-break (design 44):

1. lower total cost;
2. fewer written symbols (atoms) — vacuous in onset-only mode;
3. fewer tuplets — always vacuous until the tuplet model (QNT-005);
4. fewer ties — vacuous in onset-only mode;
5. earlier/simpler grid family — vacuous on the single binary grid;
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
from hornscribe.rhythm.lattice import OnsetCandidate
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.realize import IntervalRealization, SpanRealizer


@dataclass(frozen=True)
class OnsetPath:
    """One ranked onset hypothesis: an exact position per input note.

    ``realizations`` carries the chosen per-interval note/rest decomposition
    (QNT-003): entry ``i`` realizes ``[positions[i], positions[i+1])`` and the
    last entry is the phrase-end interval. It stays empty in onset-only mode
    (no ``SpanRealizer``) — the caller then emits provisional durations.
    """

    positions: tuple[Fraction, ...]
    """Quantized onset per input note, strictly increasing, exact Fractions."""
    cost: float
    """Total onset + IOI (+ realization) cost accumulated along the path."""
    realizations: tuple[IntervalRealization, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "positions", tuple(self.positions))
        object.__setattr__(self, "realizations", tuple(self.realizations))
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


@dataclass(frozen=True)
class _PathState:
    """Partial path ending at one candidate node."""

    cost: float
    positions: tuple[Fraction, ...]
    symbols: int = 0
    """Written atoms accumulated by realized intervals so far (design 44)."""
    ties: int = 0
    """Ties accumulated by realized intervals so far (design 44)."""
    realizations: tuple[IntervalRealization, ...] = ()


def _path_key(state: _PathState) -> tuple[float, int, int, tuple[Fraction, ...]]:
    """Deterministic path order (design 44): cost, symbols, ties, positions."""
    return (state.cost, state.symbols, state.ties, state.positions)


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

    # Layer 0: node cost only.
    layer: list[list[_PathState]] = [
        [_PathState(cost=onset_cost(c, notes[0], profile), positions=(c.position_ql,))]
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
                interval = (
                    realizer.interval(
                        prev.position_ql, curr.position_ql, notes[i - 1]
                    )
                    if realizer is not None
                    else None
                )
                interval_cost = interval.cost if interval is not None else 0.0
                for state in prev_states:
                    pool.append(
                        _PathState(
                            cost=state.cost + curr_cost + transition + interval_cost,
                            positions=(*state.positions, curr.position_ql),
                            symbols=state.symbols
                            + (interval.symbol_count if interval is not None else 0),
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
        tail_by_pos: dict[Fraction, IntervalRealization] = {}
        for cand in candidates[-1]:
            tail_by_pos[cand.position_ql] = realizer.interval(
                cand.position_ql, None, notes[-1]
            )
        layer = [
            [
                _PathState(
                    cost=state.cost + tail_by_pos[cand.position_ql].cost,
                    positions=state.positions,
                    symbols=state.symbols
                    + tail_by_pos[cand.position_ql].symbol_count,
                    ties=state.ties + tail_by_pos[cand.position_ql].tie_count,
                    realizations=(*state.realizations, tail_by_pos[cand.position_ql]),
                )
                for state in states
            ]
            for cand, states in zip(candidates[-1], layer, strict=True)
        ]

    final = _top_k([state for states in layer for state in states], k)
    return tuple(
        OnsetPath(positions=s.positions, cost=s.cost, realizations=s.realizations)
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
