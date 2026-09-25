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

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from hornscribe.domain.score import KeyChange, KeySignature

# Krumhansl-Kessler probe profiles (pitch-class C..B order).
_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

# Circle-of-fifths position of each tonic pitch class (C=0, G=1, ...).
_FIFTHS_BY_PC = (0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5)


@dataclass(frozen=True)
class KeyEstimate:
    """One estimated key plus the runner-up candidate (#352).

    ``runner_up`` is the second-best Krumhansl-Schmuckler match — the
    ambiguity the UI needs to warn about (a relative major/minor pair
    explains the same diatonic notes almost as well). ``margin`` is
    best-minus-runner-up correlation; ``None`` only when there was no
    second candidate to compare against.
    """

    key: KeySignature
    confidence: float
    runner_up: KeySignature | None = None
    runner_up_confidence: float | None = None

    @property
    def margin(self) -> float | None:
        if self.runner_up_confidence is None:
            return None
        return self.confidence - self.runner_up_confidence


def _histogram(
    pitches: tuple[int, ...],
    durations_ql: tuple[Fraction, ...],
) -> list[float] | None:
    """Normalized duration-weighted pitch-class histogram, or None when
    the material has no weight at all."""
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
        return None
    return [v / total for v in histogram]


def estimate_key_detailed(
    pitches: tuple[int, ...],
    durations_ql: tuple[Fraction, ...],
) -> KeyEstimate:
    """``estimate_key`` plus the runner-up candidate (#352)."""
    histogram = _histogram(pitches, durations_ql)
    if histogram is None:
        return KeyEstimate(KeySignature(fifths=0, mode="major"), 0.0)
    top = _top_keys(histogram)
    (key, conf), (up_key, up_conf) = top[0], top[1]
    return KeyEstimate(key, conf, up_key, up_conf)


def estimate_key(
    pitches: tuple[int, ...],
    durations_ql: tuple[Fraction, ...],
) -> tuple[KeySignature, float]:
    """Best-fit key for a monophonic line.

    ``pitches``/``durations_ql`` are parallel sequences (canonical MIDI +
    exact span). Returns ``(KeySignature, correlation)``; an empty input
    yields C major with correlation 0 so callers can flag it.
    """
    est = estimate_key_detailed(pitches, durations_ql)
    return est.key, est.confidence


def _signature(tonic: int, mode: str) -> KeySignature:
    """Tonic pitch class + mode -> notated key signature."""
    fifths = _FIFTHS_BY_PC[tonic]
    if mode == "minor":
        # Relative major shares the signature: A minor -> C major (0).
        fifths = _FIFTHS_BY_PC[(tonic + 3) % 12]
    if fifths > 6:  # Cb/Gb side collapses to the flat spelling
        fifths -= 12
    return KeySignature(fifths=fifths, mode=mode)


def _top_keys(histogram: list[float]) -> list[tuple[KeySignature, float]]:
    """All 24 (key, correlation) candidates for a normalized pitch-class
    histogram, best first. Ties keep tonic order with major before
    minor — the historical first-match behaviour."""
    scored = [
        (_correlate(histogram, profile, tonic), tonic, mode)
        for tonic in range(12)
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor"))
    ]
    scored.sort(key=lambda s: s[0], reverse=True)
    return [(_signature(tonic, mode), score) for score, tonic, mode in scored]


def _best_key(histogram: list[float]) -> tuple[KeySignature, float]:
    """Best-fit key for a normalized pitch-class histogram."""
    return _top_keys(histogram)[0]


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


@dataclass(frozen=True)
class KeySegmentEstimate:
    """Evidence for one emitted key-map span (#352).

    ``measure`` is the 1-based measure number the span starts at — the
    same numbering the properties key-map editor shows — so review
    copy can name the bar without knowing the meter.
    """

    start_beat: Fraction
    measure: int
    estimate: KeyEstimate
    note_count: int
    weight: float


@dataclass(frozen=True)
class KeyAnalysis:
    """Full key-map result: the head estimate plus emitted segments.

    ``head`` is the key written at beat 0 together with its runner-up.
    ``confidence`` is the whole-piece correlation for a single-key
    piece, the duration-weighted mean of segment correlations when the
    piece modulates — the value ``meta.keyConfidence`` reports.
    """

    head: KeyEstimate
    changes: tuple[KeyChange, ...]
    segments: tuple[KeySegmentEstimate, ...]
    confidence: float
    note_count: int
    weight: float

    @property
    def key(self) -> KeySignature:
        return self.head.key


def analyze_key(
    pitches: tuple[int, ...],
    onsets_ql: tuple[Fraction, ...],
    durations_ql: tuple[Fraction, ...],
    measure_starts_ql: tuple[Fraction, ...],
) -> KeyAnalysis:
    """Estimate the key map with full per-candidate evidence (#133/#352).

    measure_starts_ql is the sorted list of measure start positions on
    the canonical axis (QL), beginning at 0 — the same axis the returned
    KeyChange.start_beat values live on (the caller converts when the
    beat unit is not a quarter). Each note is binned into the measure
    its onset falls in; a DP then picks the segmentation minimizing
    -sum(duration * correlation) plus a per-split penalty.
    """
    head = estimate_key_detailed(pitches, durations_ql)
    total_weight = float(sum(durations_ql))

    def single() -> KeyAnalysis:
        return KeyAnalysis(
            head=head,
            changes=(),
            segments=(
                KeySegmentEstimate(
                    start_beat=Fraction(0),
                    measure=1,
                    estimate=head,
                    note_count=len(pitches),
                    weight=total_weight,
                ),
            ),
            confidence=head.confidence,
            note_count=len(pitches),
            weight=total_weight,
        )

    measure_count = len(measure_starts_ql)
    if (
        not pitches
        or measure_count < 2 * _MIN_SEG_MEASURES + 1
        or measure_count > _MAX_MEASURES
    ):
        return single()

    # Per-measure duration-weighted histograms, plus the first/last note
    # of each measure so a segment-level cadence bias matches the global
    # estimator's.
    histograms = [[0.0] * 12 for _ in range(measure_count)]
    counts = [0] * measure_count
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
        counts[m] += 1
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

    seg_total = sum(prefix[measure_count][pc] for pc in range(12))
    if seg_total <= 0:
        return single()
    penalty = _SPLIT_PENALTY * seg_total

    seg_cache: dict[tuple[int, int], tuple[KeyEstimate, float]] = {}

    def segment_key(i: int, j: int) -> tuple[KeyEstimate, float]:
        """(estimate, duration weight) of measures [i, j)."""
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
            result = (KeyEstimate(head.key, -1.0), 0.0)
        else:
            normalized = [v / weight for v in hist]
            top = _top_keys(normalized)
            (k, c), (up_key, up_conf) = top[0], top[1]
            result = (KeyEstimate(k, c, up_key, up_conf), weight)
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
            est, weight = segment_key(i, j)
            cost = dp[i][0] - weight * est.confidence + (
                penalty if i > 0 else 0.0
            )
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
        return single()

    # Merge adjacent segments that landed on the same signature into
    # the emitted spans, then emit the key map. Confidence is the
    # duration-weighted mean of the per-segment correlations.
    spans: list[tuple[int, int]] = []
    weighted = 0.0
    weight_sum = 0.0
    prev_key: KeySignature | None = None
    for idx, i in enumerate(bounds):
        j = bounds[idx + 1] if idx + 1 < len(bounds) else measure_count
        est, weight = segment_key(i, j)
        weighted += weight * est.confidence
        weight_sum += weight
        if est.key == prev_key:
            spans[-1] = (spans[-1][0], j)
            continue
        spans.append((i, j))
        prev_key = est.key
    if len(spans) <= 1:
        return single()

    changes: list[KeyChange] = []
    segments: list[KeySegmentEstimate] = []
    for idx, (i, j) in enumerate(spans):
        est, weight = segment_key(i, j)
        # The payload contract: first change at beat 0 carrying the
        # head key.
        start = Fraction(0) if idx == 0 else Fraction(starts[i])
        changes.append(KeyChange(start_beat=start, key_signature=est.key))
        segments.append(
            KeySegmentEstimate(
                start_beat=start,
                measure=i + 1,
                estimate=est,
                note_count=sum(counts[i:j]),
                weight=weight,
            )
        )
    seg_conf = weighted / weight_sum if weight_sum > 0 else head.confidence
    return KeyAnalysis(
        head=segments[0].estimate,
        changes=tuple(changes),
        segments=tuple(segments),
        confidence=seg_conf,
        note_count=len(pitches),
        weight=total_weight,
    )


def estimate_key_segments(
    pitches: tuple[int, ...],
    onsets_ql: tuple[Fraction, ...],
    durations_ql: tuple[Fraction, ...],
    measure_starts_ql: tuple[Fraction, ...],
) -> tuple[KeySignature, tuple[KeyChange, ...], float]:
    """Estimate the key map: a head key plus mid-piece key changes (#133).

    Returns (head_key, key_changes, confidence). key_changes is empty
    when the piece stays in one key — the legacy single-key path —
    otherwise its first entry sits at beat 0 carrying head_key so it
    validates as a ScoreRevisionPayload key map.
    """
    analysis = analyze_key(pitches, onsets_ql, durations_ql, measure_starts_ql)
    return analysis.key, analysis.changes, analysis.confidence


# #352 uncertainty bars for ReviewReason.KEY_UNCERTAIN. Correlation is a
# Pearson value over the K-S profiles: 0.5 is already a weak tonal match
# (clear diatonic melodies reach 0.8+), and a best-vs-runner-up gap under
# 0.06 means two keys explain the notes almost equally well — relative
# major/minor ambiguity sits there. Fewer than six notes simply cannot
# carry a key whatever the correlation says.
_UNCERTAIN_CONFIDENCE = 0.5
_UNCERTAIN_MARGIN = 0.06
_MIN_NOTES_FOR_KEY = 6


def _uncertainty_flags(est: KeyEstimate, note_count: int) -> list[str]:
    flags: list[str] = []
    if note_count < _MIN_NOTES_FOR_KEY:
        flags.append("too_few_notes")
    if est.confidence < _UNCERTAIN_CONFIDENCE:
        flags.append("low_confidence")
    margin = est.margin
    if margin is not None and margin < _UNCERTAIN_MARGIN:
        flags.append("close_candidates")
    return flags


def key_uncertainty(analysis: KeyAnalysis) -> dict[str, Any] | None:
    """Review evidence when the key estimate cannot stand alone (#352).

    Returns ``None`` when the estimate is clear enough to write without
    a prompt; otherwise the ``ReviewIssue.evidence`` dict — the estimated
    key, its confidence, the runner-up with margin, the amount of
    material analysed, and per-segment stats when the piece modulates.
    ``details`` names the machine-readable flags so the UI copy can
    phrase the real problem instead of a generic warning.
    """
    if analysis.note_count == 0:
        # An empty score has no written key to question.
        return None
    details = _uncertainty_flags(analysis.head, analysis.note_count)
    segment_reports: list[dict[str, Any]] = []
    uncertain_measures: list[int] = []
    if len(analysis.segments) > 1:
        for seg in analysis.segments:
            flags = _uncertainty_flags(seg.estimate, seg.note_count)
            margin = seg.estimate.margin
            segment_reports.append(
                {
                    "measure": seg.measure,
                    "startBeat": str(seg.start_beat),
                    "fifths": seg.estimate.key.fifths,
                    "mode": seg.estimate.key.mode,
                    "confidence": round(seg.estimate.confidence, 3),
                    "margin": (
                        round(margin, 3) if margin is not None else None
                    ),
                    "noteCount": seg.note_count,
                    "weight": round(seg.weight, 3),
                    "uncertain": bool(flags),
                }
            )
            if flags:
                uncertain_measures.append(seg.measure)
        if uncertain_measures:
            details.append("segment_uncertain")
    if not details:
        return None
    head = analysis.head
    head_margin = head.margin
    evidence: dict[str, Any] = {
        "details": details,
        "keyFifths": head.key.fifths,
        "keyMode": head.key.mode,
        "keyConfidence": round(head.confidence, 3),
        "runnerUpFifths": (
            head.runner_up.fifths if head.runner_up is not None else None
        ),
        "runnerUpMode": (
            head.runner_up.mode if head.runner_up is not None else None
        ),
        "runnerUpConfidence": (
            round(head.runner_up_confidence, 3)
            if head.runner_up_confidence is not None
            else None
        ),
        "keyMargin": (
            round(head_margin, 3) if head_margin is not None else None
        ),
        "noteCount": analysis.note_count,
        # Summed duration weight of the analysed notes (on the axis the
        # caller passed — beats for the pipeline).
        "analyzedWeight": round(analysis.weight, 3),
    }
    if segment_reports:
        evidence["segments"] = segment_reports
        evidence["uncertainSegments"] = uncertain_measures
    return evidence
