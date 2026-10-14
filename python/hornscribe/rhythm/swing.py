"""Swing/shuffle feel detection (#134).

The quantizer only knows straight subdivisions and triplets, so a
shuffle (eighth-note backbeat pulled to the triplet's third position)
is silently written as triplets — or worse, flagged ambiguous. This
detector reads the normalized onset phases inside each beat and
classifies the offbeat onsets:

    triplet  ~1/3 of a beat   (real triplets also land at 2/3, so a
    straight  ~1/2             triplet reading needs BOTH clusters)
    swing    ~2/3
    dotted   >~0.708           (the dotted-8th+16th offbeat — binary
                               figure evidence, NEVER a swing vote;
                               #256)

A piece reads as swung when the 2/3 cluster dominates the 1/2 cluster
AND the 1/3 cluster stays quiet — that second condition separates a
shuffle from genuine triplet writing. The result feeds both the
review issue and the payload's swingFeel direction, so a false
positive prints a wrong marking on the score — the census must be
conservative about what counts as swing evidence.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from fractions import Fraction

# Phase landmarks inside one beat (fractions of the beat).
_TRIPLET_PHASE = 1.0 / 3.0
_STRAIGHT_PHASE = 0.5
_SWING_PHASE = 2.0 / 3.0

# An onset votes for its NEAREST landmark when within this window —
# wide enough to catch humanized timing. The windows do overlap
# (0.38..0.45 sits in both triplet and straight reach), so assignment
# is nearest-landmark rather than first-match: an early-played
# straight eighth is straight evidence, not a phantom triplet vote.
_PHASE_WINDOW = 0.12

# Only offbeat onsets carry feel information; on-beats can't tell a
# shuffle from a march. Below this count the evidence is too thin.
_MIN_OFFBEATS = 6
# The 2/3 cluster must clearly beat the straight cluster.
_MIN_SWING_RATIO = 0.55
# ...without the 1/3 cluster lighting up too (that would be triplets).
_MAX_TRIPLET_RATIO = 0.25

#: Beat-local phase band whose onsets snap to the straight eighth when
#: swing is detected (#88). The upper bound is the midpoint between the
#: swing third and the dotted sixteenth, so a *real* dotted figure
#: (phase ~0.75) keeps its binary candidates while a swung offbeat
#: writes as a straight eighth under the swingFeel direction.
SWING_SNAP_PHASE_LO = 0.55
SWING_SNAP_PHASE_HI = (2.0 / 3.0 + 0.75) / 2.0  # ~0.708

# #256: the same midpoint caps the swing *census* — a dotted-figure
# offbeat (phase ~0.75) must not vote for the very swing reading that
# would print a contradicting <swing> direction over written dotted
# rhythm. Onsets past the boundary count as dotted evidence instead.


@dataclass(frozen=True)
class SwingEstimate:
    """Offbeat onset census for one piece."""

    offbeats: int
    swing: int
    triplet: int
    straight: int
    dotted: int = 0
    """Onsets past the swing/dotted midpoint — binary-figure evidence
    (dotted-8th+16th writing). They dilute the swing ratio through
    the offbeats denominator but never vote for it."""
    mean_phase: Fraction | None = None
    """Mean phase (fraction of a beat) of the onsets that landed in the
    swing cluster — the detected swing amount, e.g. 2/3 for a hard
    shuffle or ~0.6 for a softer feel. None when nothing clustered."""

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
    offbeats = swing = triplet = straight = dotted = 0
    unit = float(beat_ql)
    swing_phases: list[Fraction] = []
    for onset in onsets_ql:
        phase = float(onset) / unit % 1.0
        # Fold the tiny pre-beat tail (phase ~1.0) onto the downbeat.
        if phase > 0.9:
            phase -= 1.0
        if phase < 0.12:
            continue  # on the beat — no feel information
        offbeats += 1
        if phase > SWING_SNAP_PHASE_HI:
            # Dotted-figure territory (#256): a phase past the
            # swing-third/dotted-16th midpoint is binary-figure
            # evidence — the same boundary the snap band honours —
            # and never a swing vote.
            dotted += 1
            continue
        d_swing = abs(phase - _SWING_PHASE)
        d_straight = abs(phase - _STRAIGHT_PHASE)
        d_triplet = abs(phase - _TRIPLET_PHASE)
        nearest = min(d_swing, d_straight, d_triplet)
        if nearest > _PHASE_WINDOW:
            continue
        if nearest == d_swing:
            swing += 1
            swing_phases.append(Fraction(phase).limit_denominator(24))
        elif nearest == d_triplet:
            triplet += 1
        else:
            straight += 1
    mean_phase = sum(swing_phases, Fraction(0)) / len(swing_phases) if swing_phases else None
    return SwingEstimate(
        offbeats=offbeats,
        swing=swing,
        triplet=triplet,
        straight=straight,
        dotted=dotted,
        mean_phase=mean_phase,
    )
