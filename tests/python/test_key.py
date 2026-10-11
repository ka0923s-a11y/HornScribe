"""#145: harmony-aware key refinement — the melodic K-S estimate must
not commit to a signature the detected chord set contradicts."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction as F

from hornscribe.transcription.key import (
    estimate_key_detailed,
    refine_key_with_harmony,
)


@dataclass
class _Chord:
    start_sec: float
    end_sec: float
    root_pc: int
    quality: str
    confidence: float = 0.8
    margin: float = 0.0


# The jpop-mix fixture's melody: A-pentatonic over Am F C G, ending on
# the dominant E — the cadence bias alone misreads it as E minor.
_JPOP_MELODY = (
    (4, 76), (4, 79), (2, 81), (2, 79), (4, 76),
    (2, 77), (2, 76), (2, 77), (2, 79), (8, 81),
    (4, 79), (4, 76), (2, 74), (2, 72), (4, 74),
    (2, 72), (2, 76), (2, 74), (2, 71), (8, 74),
    (4, 76), (2, 77), (2, 79), (4, 81), (4, 79),
    (2, 74), (2, 77), (4, 76), (4, 74), (4, 72),
    (4, 74), (2, 72), (2, 74), (4, 76), (4, 72),
    (2, 71), (2, 74), (12, 76),
)


def _chords(*seq):
    bar = 1.875
    return tuple(
        _Chord(b * bar, (b + 1) * bar, pc, q)
        for b, (pc, q) in enumerate(seq)
    )


def test_harmony_overrides_contradicted_signature():
    pitches = tuple(m for _d, m in _JPOP_MELODY)
    durs = tuple(F(d) for d, _m in _JPOP_MELODY)
    head = estimate_key_detailed(pitches, durs)
    # Regression fixture: the melodic estimate really does land on
    # E minor here — the contradiction the refinement exists for.
    assert head.key.fifths == 1 and head.key.mode == "minor"
    chords = _chords(
        (9, "min"), (5, "maj"), (0, "maj"), (7, "maj"),
        (9, "min"), (5, "maj"), (0, "maj"), (7, "maj"),
    )
    refined = refine_key_with_harmony(pitches, durs, chords)
    assert refined is not None
    assert refined.key.fifths == 0 and refined.key.mode == "minor"
    # The displaced melodic winner is reported as the runner-up —
    # reviewers see both votes.
    assert refined.runner_up is not None
    assert refined.runner_up.fifths == 1


def test_consistent_harmony_keeps_melodic_answer():
    pitches = (60, 62, 64, 65, 67, 69, 71, 72)
    durs = tuple(F(1) for _ in pitches)
    chords = _chords((0, "maj"), (5, "maj"), (7, "maj"), (0, "maj"))
    assert refine_key_with_harmony(pitches, durs, chords) is None


def test_no_chords_no_refinement():
    pitches = (60, 62, 64, 65, 67, 69, 71, 72)
    durs = tuple(F(1) for _ in pitches)
    assert refine_key_with_harmony(pitches, durs, ()) is None


def test_first_chord_tonic_only_arbiters_near_ties():
    # A melody strongly in G major must not flip to C major just
    # because the piece opens on a IV chord.
    pitches = (67, 69, 71, 72, 74, 76, 74, 67) * 4
    durs = tuple(F(2) for _ in pitches)
    chords = _chords((0, "maj"), (7, "maj"), (2, "min"), (7, "maj"))
    refined = refine_key_with_harmony(pitches, durs, chords)
    assert refined is None or (
        refined.key.fifths == 1 and refined.key.mode == "major"
    )
