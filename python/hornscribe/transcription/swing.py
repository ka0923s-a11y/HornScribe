"""Swing/shuffle feel detection (#134).

The quantizer only knows straight subdivisions and triplets, so a
shuffle (eighth-note backbeat pulled to the triplet's third position)
is silently written as triplets — or worse, flagged ambiguous. This
detector reads the normalized onset phases inside each beat and
classifies the offbeat onsets:

    triplet  ~1/3 of a beat   (real triplets also land at 2/3, so a
    straight  ~1/2             triplet reading needs BOTH clusters)
    swing    ~2/3

A piece reads as swung when the 2/3 cluster dominates the 1/2 cluster
AND the 1/3 cluster stays quiet — that second condition separates a
shuffle from genuine triplet writing. The result only feeds a review
issue; the score itself is left alone.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from fractions import Fraction

# Phase landmarks inside one beat (fractions of the beat).
_TRIPLET_PHASE = 1.0 / 3.0
_STRAIGHT_PHASE = 0.5
_SWING_PHASE = 2.0 / 3.0

# An onset counts toward a landmark when it sits within this window —
# wide enough to catch humanized timing, narrow enough that the three
# clusters cannot overlap (1/3..2/3 span is 0.167 wide each side).
_PHASE_WINDOW = 0.12

# Only offbeat onsets carry feel information; on-beats can't tell a
# shuffle from a march. Below this count the evidence is too thin.
_MIN_OFFBEATS = 12
# The 2/3 cluster must clearly beat the straight cluster.
_MIN_SWING_RATIO = 0.55
# ...without the 1/3 cluster lighting up too (that would be triplets).
_MAX_TRIPLET_RATIO = 0.25


@dataclass(frozen=True)
class SwingEstimate:
    """Offbeat onset census for one piece."""

    offbeats: int
    swing: int
    triplet: int
    straight: int

    @property
    def detected(self) -> bool:
        if self.offbeats < _MIN_OFFBEATS:
            return False
        return (
            self.swing / self.offbeats >= _MIN_SWING_RATIO
            and self.swing > self.straight
            and self.triplet / self.offbeats <= _MAX_TRIPLET_RATIO
        )

    @property
    def swing_ratio(self) -> float:
        return self.swing / self.offbeats if self.offbeats else 0.0


def detect_swing(
    onsets_ql: Iterable[Fraction | float],
    beat_ql: Fraction = Fraction(1),
) -> SwingEstimate:
    """Census offbeat onset phases against the beat grid.

    onsets_ql are normalized quarterLength positions (score time,
    post-warp). beat_ql is the quarterLength of one notated beat so the
    phase math stays correct under compound meters (6/8: beat = 3/2).
    """
    offbeats = swing = triplet = straight = 0
    unit = float(beat_ql)
    for onset in onsets_ql:
        phase = float(onset) / unit % 1.0
        # Fold the tiny pre-beat tail (phase ~1.0) onto the downbeat.
        if phase > 0.9:
            phase -= 1.0
        if phase < 0.12:
            continue  # on the beat — no feel information
        offbeats += 1
        if abs(phase - _SWING_PHASE) <= _PHASE_WINDOW:
            swing += 1
        elif abs(phase - _TRIPLET_PHASE) <= _PHASE_WINDOW:
            triplet += 1
        elif abs(phase - _STRAIGHT_PHASE) <= _PHASE_WINDOW:
            straight += 1
    return SwingEstimate(
        offbeats=offbeats, swing=swing, triplet=triplet, straight=straight
    )
