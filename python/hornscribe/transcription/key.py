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

from hornscribe.domain.score import KeyChange, KeySignature

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

    return _best_key(histogram)


def _best_key(histogram: list[float]) -> tuple[KeySignature, float]:
    """Best-fit key for a normalized pitch-class histogram."""
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


# #133 mid-piece key changes: segmentation knobs. A boundary must pay for
# itself — splitting a segment costs _SPLIT_PENALTY of the piece's total
# duration weight, so a modulation is only accepted when the two halves
# correlate better than the whole by a real margin. Segments shorter than
# _MIN_SEG_MEASURES are never produced (a one-bar tonicization is not a
# key change), and very long scores fall back to the single-key estimate
# rather than pay the O(M^2) dynamic program.
_MIN_SEG_MEASURES = 2
_SPLIT_PENALTY = 0.05
_MAX_MEASURES = 256


def estimate_key_segments(
    pitches: tuple[int, ...],
    onsets_ql: tuple[Fraction, ...],
    durations_ql: tuple[Fraction, ...],
    measure_starts_ql: tuple[Fraction, ...],
) -> tuple[KeySignature, tuple[KeyChange, ...], float]:
    """Estimate the key map: a head key plus mid-piece key changes (#133).

    measure_starts_ql is the sorted list of measure start positions on
    the canonical axis (QL), beginning at 0 — the same axis the returned
    KeyChange.start_beat values live on (the caller converts when the
    beat unit is not a quarter). Each note is binned into the measure
    its onset falls in; a DP then picks the segmentation minimizing
    -sum(duration * correlation) plus a per-split penalty.

    Returns (head_key, key_changes, confidence). key_changes is empty
    when the piece stays in one key — the legacy single-key path —
    otherwise its first entry sits at beat 0 carrying head_key so it
    validates as a ScoreRevisionPayload key map.
    """
    head, conf = estimate_key(pitches, durations_ql)
    measure_count = len(measure_starts_ql)
    if (
        not pitches
        or measure_count < 2 * _MIN_SEG_MEASURES + 1
        or measure_count > _MAX_MEASURES
    ):
        return head, (), conf

    # Per-measure duration-weighted histograms, plus the first/last note
    # of each measure so a segment-level cadence bias matches the global
    # estimator's.
    histograms = [[0.0] * 12 for _ in range(measure_count)]
    first_pc: list[int | None] = [None] * measure_count
    first_dur = [0.0] * measure_count
    last_pc: list[int | None] = [None] * measure_count
    last_dur = [0.0] * measure_count
    starts = list(measure_starts_ql)
    for pitch, onset, dur in zip(pitches, onsets_ql, durations_ql, strict=True):
        # bisect_right - 1: the measure whose start is <= onset.
        lo, hi = 0, measure_count
        while lo < hi:
            mid = (lo + hi) // 2
            if starts[mid] <= onset:
                lo = mid + 1
            else:
                hi = mid
        m = max(0, lo - 1)
        histograms[m][pitch % 12] += float(dur)
        if first_pc[m] is None:
            first_pc[m] = pitch % 12
            first_dur[m] = float(dur)
        last_pc[m] = pitch % 12
        last_dur[m] = float(dur)

    # Prefix sums over the 12 pitch classes make any segment's histogram
    # an O(12) lookup.
    prefix = [[0.0] * 12 for _ in range(measure_count + 1)]
    for m in range(measure_count):
        for pc in range(12):
            prefix[m + 1][pc] = prefix[m][pc] + histograms[m][pc]

    total_weight = sum(prefix[measure_count][pc] for pc in range(12))
    if total_weight <= 0:
        return head, (), conf
    penalty = _SPLIT_PENALTY * total_weight

    seg_cache: dict[tuple[int, int], tuple[KeySignature, float, float]] = {}

    def segment_key(i: int, j: int) -> tuple[KeySignature, float, float]:
        """(key, correlation, weight) of measures [i, j)."""
        hit = seg_cache.get((i, j))
        if hit is not None:
            return hit
        hist = [prefix[j][pc] - prefix[i][pc] for pc in range(12)]
        # Cadence bias on the segment's boundary notes (same weights as
        # estimate_key: last x2, first x1.5 total).
        fp, fd = first_pc[i], first_dur[i]
        lp, ld = last_pc[j - 1], last_dur[j - 1]
        if fp is not None:
            hist[fp] += fd * 0.5
        if lp is not None:
            hist[lp] += ld
        weight = sum(hist)
        if weight <= 0:
            result = (head, -1.0, 0.0)
        else:
            normalized = [v / weight for v in hist]
            k, c = _best_key(normalized)
            result = (k, c, weight)
        seg_cache[(i, j)] = result
        return result

    # dp[j] = best (cost, prev_i) covering measures [0, j).
    inf = float("inf")
    dp: list[tuple[float, int]] = [(inf, -1)] * (measure_count + 1)
    dp[0] = (0.0, -1)
    for j in range(_MIN_SEG_MEASURES, measure_count + 1):
        best_cost, best_i = inf, -1
        for i in range(0, j - _MIN_SEG_MEASURES + 1):
            if i != 0 and i < _MIN_SEG_MEASURES:
                continue
            if dp[i][1] == -1 and i != 0:
                continue
            _k, corr, weight = segment_key(i, j)
            cost = dp[i][0] - weight * corr + (penalty if i > 0 else 0.0)
            if cost < best_cost:
                best_cost, best_i = cost, i
        dp[j] = (best_cost, best_i)

    # Reconstruct segment boundaries.
    bounds: list[int] = []
    j = measure_count
    while j > 0:
        i = dp[j][1]
        if i < 0:
            bounds = []
            break
        bounds.append(i)
        j = i
    bounds.reverse()
    if len(bounds) <= 1:
        return head, (), conf

    # Merge adjacent segments that landed on the same signature, then
    # emit the key map. Confidence is the duration-weighted mean of the
    # per-segment correlations.
    changes: list[KeyChange] = []
    weighted = 0.0
    weight_sum = 0.0
    prev_key: KeySignature | None = None
    for idx, i in enumerate(bounds):
        j = bounds[idx + 1] if idx + 1 < len(bounds) else measure_count
        k, corr, weight = segment_key(i, j)
        weighted += weight * corr
        weight_sum += weight
        if k == prev_key:
            continue
        changes.append(
            KeyChange(start_beat=Fraction(starts[i]), key_signature=k)
        )
        prev_key = k
    if len(changes) <= 1:
        return head, (), conf
    # The payload contract: first change at beat 0 carrying the head key.
    changes[0] = KeyChange(
        start_beat=Fraction(0), key_signature=changes[0].key_signature
    )
    seg_conf = weighted / weight_sum if weight_sum > 0 else conf
    return changes[0].key_signature, tuple(changes), seg_conf
