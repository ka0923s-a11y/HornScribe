"""Key estimation from quantized pitches (ENG-002).

Krumhansl-Schmuckler: correlate the duration-weighted pitch-class
histogram against the 24 canonical major/minor key profiles and take
the best match. Deterministic, dependency-free, and honest — the
estimated key is reported in the result meta so a wrong guess is
inspectable rather than hidden.

Profile weights are the classic Krumhansl-Kessler values. Minor keys
map to fifths via the relative major (A minor = 0, E minor = +1, ...).
"""

from __future__ import annotations

from fractions import Fraction

from hornscribe.domain.score import KeySignature

# Krumhansl-Kessler probe profiles (pitch-class C..B order).
_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

# Circle-of-fifths position of each tonic pitch class (C=0, G=1, ...).
_FIFTHS_BY_PC = (0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5)


def estimate_key(
    pitches: tuple[int, ...],
    durations_ql: tuple[Fraction, ...],
) -> tuple[KeySignature, float]:
    """Best-fit key for a monophonic line.

    ``pitches``/``durations_ql`` are parallel sequences (canonical MIDI +
    exact span). Returns ``(KeySignature, correlation)``; an empty input
    yields C major with correlation 0 so callers can flag it.
    """
    histogram = [0.0] * 12
    for pitch, dur in zip(pitches, durations_ql, strict=True):
        histogram[pitch % 12] += float(dur)
    # Cadence bias: monophonic melodies overwhelmingly begin and — more
    # reliably — end on the tonic. K-S alone ties relative major/minor
    # on diatonic material (an all-white-note scale scores A minor over
    # C major); doubling the final note's weight and half-weighting the
    # first breaks that tie toward the real tonic without changing the
    # signature when the melody genuinely cadences elsewhere.
    if pitches:
        histogram[pitches[-1] % 12] += float(durations_ql[-1])
        histogram[pitches[0] % 12] += float(durations_ql[0]) * 0.5
    total = sum(histogram)
    if total <= 0:
        return KeySignature(fifths=0, mode="major"), 0.0
    histogram = [v / total for v in histogram]

    best: tuple[float, int, str] = (-2.0, 0, "major")
    for tonic in range(12):
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            score = _correlate(histogram, profile, tonic)
            if score > best[0]:
                best = (score, tonic, mode)
    _score, tonic, mode = best
    fifths = _FIFTHS_BY_PC[tonic]
    if mode == "minor":
        # Relative major shares the signature: A minor -> C major (0).
        fifths = _FIFTHS_BY_PC[(tonic + 3) % 12]
    if fifths > 6:  # Cb/Gb side collapses to the flat spelling
        fifths -= 12
    return KeySignature(fifths=fifths, mode=mode), best[0]


def _correlate(histogram: list[float], profile: tuple[float, ...], tonic: int) -> float:
    """Pearson correlation between the histogram and *profile* rotated to
    *tonic*."""
    n = 12
    h_mean = sum(histogram) / n
    p_mean = sum(profile) / n
    num = 0.0
    h_var = 0.0
    p_var = 0.0
    for pc in range(n):
        h = histogram[pc] - h_mean
        p = profile[(pc - tonic) % n] - p_mean
        num += h * p
        h_var += h * h
        p_var += p * p
    if h_var == 0.0 or p_var == 0.0:
        return -1.0
    return float(num / (h_var * p_var) ** 0.5)
