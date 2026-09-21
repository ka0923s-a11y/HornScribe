"""Beat anchors and beat maps (QUANTIZER_DESIGN.md sections 5.2 and 6).

A :class:`BeatAnchor` pins a physical performance time in seconds to an exact
score position in quarterLength units (1.0 ql = one quarter note). A
:class:`BeatMap` is the validated, time-ordered anchor sequence consumed by
:class:`hornscribe.rhythm.TimeWarp`.

Anchors carry score-space positions, not bare beat numbers, so a 4/4 quarter
pulse (``0, 1, 2, ...`` ql) and a 6/8 dotted-quarter pulse (``0, 3/2, 3, ...``
ql) are unambiguous inside the quantizer (design section 5.2).
"""

from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass
from enum import Enum
from fractions import Fraction
from itertools import pairwise

from hornscribe.rhythm._util import as_exact_fraction


class BeatSource(Enum):
    """Where a beat anchor's timing evidence came from (design section 29)."""

    MANUAL = "manual"
    """Placed by the user; always the highest-authority source."""
    BEAT_TRACKER = "beat_tracker"
    """Estimated by an automatic beat tracker (e.g. librosa ``beat_track``)."""
    TEMPO_MAP = "tempo_map"
    """Derived from a tempo map / fixed-BPM projection."""


class InvalidBeatMapError(ValueError):
    """A beat map that is not a strictly monotonic seconds -> ql function."""


@dataclass(frozen=True)
class BeatAnchor:
    """One anchor point mapping ``time_sec`` -> ``score_pos_ql`` (design 5.2).

    ``score_pos_ql`` is an exact :class:`~fractions.Fraction` in quarterLength
    units. ``float`` inputs are rejected so symbolic positions can never pick
    up binary floating-point drift; pass ``Fraction`` (or ``int``) values.
    """

    time_sec: float
    score_pos_ql: Fraction
    confidence: float | None = None
    source: BeatSource = BeatSource.MANUAL

    def __post_init__(self) -> None:
        if not math.isfinite(self.time_sec):
            raise ValueError(f"anchor time_sec must be finite, got {self.time_sec!r}")
        object.__setattr__(
            self, "score_pos_ql", as_exact_fraction(self.score_pos_ql, name="score_pos_ql")
        )
        if self.confidence is not None and (
            not math.isfinite(self.confidence) or not 0.0 <= self.confidence <= 1.0
        ):
            raise ValueError(
                f"anchor confidence must be in [0, 1], got {self.confidence!r}"
            )
        if not isinstance(self.source, BeatSource):
            raise TypeError(f"source must be a BeatSource, got {self.source!r}")


@dataclass(frozen=True)
class BeatMap:
    """Validated, strictly increasing sequence of beat anchors (design 6.1).

    Invariants enforced at construction, so an invalid map fails immediately
    and clearly instead of producing a corrupt warp:

    * at least two anchors (a piecewise-linear warp needs a slope);
    * ``time_sec`` strictly increasing (duplicate/ambiguous times rejected);
    * ``score_pos_ql`` strictly increasing — a non-monotonic map (tempo
      running backwards, or a zero-tempo segment) raises
      :class:`InvalidBeatMapError`.

    Anchors are stored sorted by ``time_sec``; input order does not matter.
    """

    anchors: tuple[BeatAnchor, ...]

    def __post_init__(self) -> None:
        anchors = tuple(sorted(self.anchors, key=lambda a: a.time_sec))
        object.__setattr__(self, "anchors", anchors)
        if len(anchors) < 2:
            raise InvalidBeatMapError(
                f"beat map needs at least 2 anchors, got {len(anchors)}"
            )
        for prev, cur in pairwise(anchors):
            if cur.time_sec <= prev.time_sec:
                raise InvalidBeatMapError(
                    "anchor times must strictly increase: "
                    f"{prev.time_sec} !< {cur.time_sec} (duplicate time)"
                )
            if cur.score_pos_ql <= prev.score_pos_ql:
                raise InvalidBeatMapError(
                    "beat map must be monotonic: score_pos_ql did not increase "
                    f"({prev.score_pos_ql} -> {cur.score_pos_ql} at {cur.time_sec}s)"
                )

    def __len__(self) -> int:
        return len(self.anchors)

    def __iter__(self) -> Iterator[BeatAnchor]:
        return iter(self.anchors)

    @property
    def start_sec(self) -> float:
        """Time of the first anchor."""
        return self.anchors[0].time_sec

    @property
    def end_sec(self) -> float:
        """Time of the last anchor."""
        return self.anchors[-1].time_sec

    @property
    def start_ql(self) -> Fraction:
        """Score position of the first anchor."""
        return self.anchors[0].score_pos_ql

    @property
    def end_ql(self) -> Fraction:
        """Score position of the last anchor."""
        return self.anchors[-1].score_pos_ql
