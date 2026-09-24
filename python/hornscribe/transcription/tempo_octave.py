"""Tempo octave-error detection (#188).

The beat tracker's classic failure is a half/double pick: the grid is
musically coherent but twice or half the notated rate. The evidence
is the ratio between the median inter-ONSET interval (IOI — how fast
the music actually attacks) and the median inter-BEAT interval (IBI —
how fast the tracker thinks the beat is):

* IOI:IBI ≈ 1/2 → beats are twice as far apart as the dominant note
  rate — the tracker halved the tempo (suggest doubling the printed
  BPM).
* IOI:IBI ≈ 2 → beats are half as far apart — the tracker doubled
  the tempo (suggest halving).

False-positive guards: a piece genuinely written in eighths reads
IOI:IBI = 1/2 too, so the detector also requires the quarter ratio
(IOI:IBI ≈ 1/4 — sixteenths) to stay quiet, and needs enough onsets
before it says anything. The result only feeds a review issue; the
score is left alone.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

# Median-interval ratios that read as octave errors.
_HALF_RATIO = 0.5
_DOUBLE_RATIO = 2.0
_QUARTER_RATIO = 0.25

# Ratio window — wide enough for humanized timing, narrow enough that
# 1/4, 1/2 and 2 cannot overlap on a log scale.
_RATIO_WINDOW = 0.15

# Evidence floors: too few onsets or beats says nothing.
_MIN_ONSETS = 12
_MIN_BEATS = 8
# The quarter ratio must stay quiet when we call a halved tempo —
# otherwise the piece is probably just written in eighths.
_MAX_QUARTER_SHARE = 0.20
# The winning ratio must own a clear majority of onset intervals.
_MIN_RATIO_SHARE = 0.55


@dataclass(frozen=True)
class TempoOctaveEstimate:
    """IOI/IBI census for one piece."""

    intervals: int
    half: int
    double: int
    quarter: int
    suggestion: str | None = None
    """"halve" or "double" the printed BPM, or None when the census
    is too thin or ambiguous to act on."""


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def detect_tempo_octave(
    onsets_sec: Iterable[float],
    beat_times_sec: Iterable[float],
) -> TempoOctaveEstimate:
    """Census IOI/IBI ratios for one transcription run.

    onsets_sec are the detected note onsets (audio seconds);
    beat_times_sec are the tracked beat anchors. Both are sorted
    internally — callers need not order them.
    """
    onsets = sorted(float(t) for t in onsets_sec)
    beats = sorted(float(t) for t in beat_times_sec)
    if len(onsets) < _MIN_ONSETS or len(beats) < _MIN_BEATS:
        return TempoOctaveEstimate(0, 0, 0, 0)
    ioi = [
        b - a for a, b in zip(onsets, onsets[1:], strict=False)
        if b - a > 0.02
    ]
    ibi = [
        b - a for a, b in zip(beats, beats[1:], strict=False)
        if b - a > 0.02
    ]
    if not ioi or not ibi:
        return TempoOctaveEstimate(0, 0, 0, 0)
    med_ibi = _median(ibi)
    if med_ibi <= 0:
        return TempoOctaveEstimate(0, 0, 0, 0)

    # Each onset interval votes for the nearest landmark ratio.
    half = double = quarter = 0
    votes = 0
    for iv in ioi:
        r = iv / med_ibi
        for landmark, bucket in (
            (_QUARTER_RATIO, "quarter"),
            (_HALF_RATIO, "half"),
            (1.0, None),
            (_DOUBLE_RATIO, "double"),
        ):
            if abs(r - landmark) / landmark <= _RATIO_WINDOW:
                votes += 1
                if bucket == "quarter":
                    quarter += 1
                elif bucket == "half":
                    half += 1
                elif bucket == "double":
                    double += 1
                break
    suggestion: str | None = None
    if votes and quarter / votes <= _MAX_QUARTER_SHARE:
        if half / votes >= _MIN_RATIO_SHARE and half > double:
            suggestion = "double"
        elif double / votes >= _MIN_RATIO_SHARE and double > half:
            suggestion = "halve"
    return TempoOctaveEstimate(
        intervals=len(ioi),
        half=half,
        double=double,
        quarter=quarter,
        suggestion=suggestion,
    )
