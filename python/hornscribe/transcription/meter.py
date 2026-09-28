"""Meter (time signature) estimation for the auto path (ENG-002).

Two evidence sources feed the estimate, weakest first:

* 'strengths' -- the tracker's onset-envelope sample at each tracked
  beat. It was the only source the caller had originally, but on real
  audio the envelope is noisy enough that genuine accent periods lose
  to spurious lags (#87: 3/4 and 6/8 read as 9/8, 12/8, or nothing).
* 'event_accents' -- '(onset_sec, post_onset_rms)' per detected note,
  measured by the pipeline in a short window after each onset.
  Performed accent survives in that window even when the onset
  envelope does not show it, so this is the production path.

With event accents the tracked beats are regularised onto a uniform
slot grid (median interval + median-residual phase), which makes the
estimate immune to an occasional dropped or inserted tracker beat --
the old 'i mod N' indexing broke on a single gap. Each slot takes
the strongest event accent inside a +-0.30-beat window, then simple
meters score as the best-phase accent ratio of their period.
Compound meters share the same periods but are gated by a
subdivision census: events strictly inside the beat vote ternary
(phase ~1/3, 2/3) or binary (phase ~1/2), and a compound score is
only boosted above its simple sibling when the groove is genuinely
ternary.

Above '_EIGHTH_LEVEL_BPM' the tracked pulse is on eighths, not
primary beats, so the same slot accents feed the lag rules instead
(a lag-6 downbeat with a lag-3 mid-bar accent is 6/8, and so on).
The lag rules are also what the strengths-only fallback uses.

Confidence is the margin between the best and runner-up score. Low
confidence never fails the job: the caller falls back to 4/4 and
surfaces a 'meter_conflict' review issue so the user can override.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from fractions import Fraction

_SIMPLE_PERIODS = ("2/4", "3/4", "4/4", "5/4")
_PERIOD_BY_METER = {"2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5}
# Compound meters by their primary-beat count (dotted-quarter beats
# per measure) for the beat-level path.
_COMPOUND_BY_BEATS = {2: "6/8", 3: "9/8", 4: "12/8"}
_COMPOUND_LABELS = frozenset(_COMPOUND_BY_BEATS.values()) | {"7/8"}
# Tie-break order -- a smaller period is the simpler reading of the
# same accent evidence.
_SORT_PERIOD = {**_PERIOD_BY_METER, "6/8": 2, "9/8": 3, "12/8": 4, "7/8": 7}

# Minimum beats before we trust the accent evidence at all.
_MIN_BEATS = 8
# Confidence below this -> caller flags a meter_conflict review issue.
UNCERTAIN_CONFIDENCE = 0.2
# A measure-start accent must lift the best phase at least this much
# over the mean for the read to count as structured at all.
_MIN_ACCENT_RATIO = 1.15
# Tracked pulse at/above this BPM is on the eighth-note level --
# score it with the lag rules, not the beat-level period/census
# logic. Below it the tracker is on primary beats (quarters for
# simple meters, dotted quarters for compound ones).
_EIGHTH_LEVEL_BPM = 200.0
# Faster still and the tracker is almost surely on sixteenths; no
# candidate mapping exists, so the estimate refuses rather than guess.
_MAX_TRACKED_BPM = 360.0
# Strengths-only fallback: lag candidates stop being meaningful above
# this pulse (the eighths were never actually tracked).
_MAX_EIGHTH_BPM = 320.0
# Event onset within this fraction of a beat counts as on-beat --
# wide enough for tracker jitter, narrow enough to keep ternary
# subdivisions (phase 1/3) out of the slot accent.
_ON_BEAT_FRAC = 0.30
# Residual window for the detector-lag correction. Interior
# subdivisions sit at frac >= ~1/4, so 0.15 keeps them out of the
# on-beat cluster that defines the systematic offset.
_LAG_WINDOW_FRAC = 0.15
# Interior-phase tolerance for the subdivision census (fraction of a
# beat; 1/3 vs 1/2 differ by 0.167, so this keeps them separable).
_CENSUS_TOL_FRAC = 0.08
# Events quieter than this share of the loudest event do not vote in
# the census -- ghost-level onsets are noise, not groove.
_CENSUS_MIN_ACCENT_SHARE = 0.2
# Compound score multiplier: ternary_ratio 0 -> base (the compound
# read collapses to a fraction of its simple sibling), 1 -> base +
# gain (the compound read wins its period). With no interior events
# at all the groove is unknowable, so a mildly binary default applies.
_COMPOUND_FACTOR_BASE = 0.4
_COMPOUND_FACTOR_GAIN = 0.9
_CENSUS_DEFAULT_TERNARY = 0.3
# A period whose accent ratio adds nothing over a proper divisor's
# is explaining the same downbeats twice (6/8's alternation also
# satisfies period 4) -- drop the larger candidate.
_REDUNDANT_PERIOD_TOLERANCE = 1.05
# Beat intervals spread wider than this mean a genuine tempo change,
# not jitter -- switch to index-space slots so a 100->140 step still
# reads accents on the beat lattice (#93).
_VARIABLE_PULSE_RATIO = 1.25
# Score-time value (quarterLength) of one tracked pulse when the
# tracker sits on eighths regardless of the winning label.
_EIGHTH_QL = Fraction(1, 2)


@dataclass(frozen=True)
class MeterEstimate:
    """Auto-meter outcome for one transcription run."""

    meter: str
    """Chosen time signature label (one of the HSQ-v1 supported set)."""
    confidence: float
    """0..1 margin of the winner over the runner-up (0 = degenerate)."""
    tracked_eighths: bool
    """True when the tracked pulse should anchor eighth-note positions
    (an eighth-level compound winner); False anchors primary beats."""
    uncertain: bool
    """True when evidence was too weak to trust -- surface a review
    issue and let the user override."""
    tracked_unit_ql: Fraction | None = None
    """Score time (quarterLength) one tracked pulse covers when it is
    not the meter's primary beat -- eighth-level tracking anchors
    Fraction(1,2) for ANY label; None anchors 'meter.beat_unit_ql'."""


def _default() -> MeterEstimate:
    return MeterEstimate(
        meter="4/4", confidence=0.0, tracked_eighths=False, uncertain=True
    )


def estimate_meter(
    beat_times_sec: tuple[float, ...],
    strengths: tuple[float, ...],
    event_accents: tuple[tuple[float, float], ...] = (),
) -> MeterEstimate:
    """Pick the best-supported meter for one transcription run.

    'event_accents' is '(onset_sec, post-onset RMS)' per detected
    note -- supplied by the pipeline, which owns the audio samples.
    With it the accent evidence comes from performed-note energy;
    without it the strengths-only lag fallback runs.
    """
    n = len(beat_times_sec)
    if n < _MIN_BEATS:
        return _default()
    intervals = sorted(
        d
        for a, b in zip(beat_times_sec, beat_times_sec[1:], strict=False)
        if (d := b - a) > 0
    )
    if not intervals:
        return _default()
    median_sec = intervals[len(intervals) // 2]
    pulse_bpm = 60.0 / median_sec
    if pulse_bpm > _MAX_TRACKED_BPM:
        # Sixteenth-level tracking (or garbage) -- no candidate
        # mapping exists at that level.
        return _default()
    if event_accents:
        variable = intervals[-1] > intervals[0] * _VARIABLE_PULSE_RATIO
        if pulse_bpm >= _EIGHTH_LEVEL_BPM:
            return _estimate_eighth_level(
                beat_times_sec, event_accents, median_sec, variable
            )
        return _estimate_beat_level(
            beat_times_sec, event_accents, median_sec, variable
        )
    return _estimate_from_strengths(beat_times_sec, strengths, pulse_bpm)


def _slot_phase(
    beat_times_sec: tuple[float, ...], interval_sec: float,
) -> float:
    """Grid origin minimising tracker-to-grid residuals.

    The median residual corrects a systematic offset without one stray
    beat dragging the phase -- the scheme the index-based estimate
    lacked, so a single dropped beat used to corrupt every 'i mod N'.
    """
    first = beat_times_sec[0]
    residuals = sorted(
        (t - first) - interval_sec * round((t - first) / interval_sec)
        for t in beat_times_sec[1:]
    )
    return first + (residuals[len(residuals) // 2] if residuals else 0.0)


def _slot_evidence(
    beat_times_sec: tuple[float, ...],
    event_accents: tuple[tuple[float, float], ...],
    interval_sec: float,
    variable: bool,
) -> tuple[list[float], int, int]:
    """(slot accents, ternary census, binary census) on the beat grid.

    Uniform mode regularises the tracked beats onto a median-interval
    grid and recentres on the onsets' own cluster -- a dropped tracker
    beat or a systematic ~40 ms detection lag cannot shift every
    interior phase. Variable mode (a real tempo step) instead reads
    each event inside its containing beat interval, so the lattice
    survives differing beat lengths (#93).
    """
    n = len(beat_times_sec)
    accents = [0.0] * n
    ternary = binary = 0
    max_accent = max((a for _, a in event_accents), default=0.0)
    lag_window = _LAG_WINDOW_FRAC * interval_sec

    if variable:
        # Index-space lattice: beat i IS slot i. Detector lag is the
        # median onset-to-nearest-beat offset in seconds.
        residuals = []
        for onset, _a in event_accents:
            i = bisect_left(beat_times_sec, onset)
            cands = [j for j in (i - 1, i) if 0 <= j < n]
            if not cands:
                continue
            offset = min(
                (onset - beat_times_sec[j] for j in cands), key=abs
            )
            if abs(offset) <= lag_window:
                residuals.append(offset)
        lag = (
            sorted(residuals)[len(residuals) // 2]
            if len(residuals) >= 3
            else 0.0
        )

        def index_pos(t: float) -> float:
            """Continuous beat-index position of an onset."""
            tt = t - lag
            i = bisect_left(beat_times_sec, tt)
            if i == 0:
                d = beat_times_sec[1] - beat_times_sec[0]
                return (tt - beat_times_sec[0]) / d if d > 0 else 0.0
            if i >= n:
                d = beat_times_sec[-1] - beat_times_sec[-2]
                return (n - 1) + (tt - beat_times_sec[-1]) / d if d > 0 else 0.0
            d = beat_times_sec[i] - beat_times_sec[i - 1]
            return (i - 1) + (tt - beat_times_sec[i - 1]) / d if d > 0 else 0.0

        for onset, accent in event_accents:
            pos = index_pos(onset)
            base = int(pos) if pos >= 0 else int(pos) - 1
            frac = pos - base
            edge = min(frac, 1.0 - frac)
            if edge <= _ON_BEAT_FRAC:
                idx = base if frac <= 0.5 else base + 1
                if 0 <= idx < n and accent > accents[idx]:
                    accents[idx] = accent
                continue
            if max_accent > 0 and accent < _CENSUS_MIN_ACCENT_SHARE * max_accent:
                continue
            ternary_dist = min(abs(frac - 1 / 3), abs(frac - 2 / 3))
            binary_dist = abs(frac - 0.5)
            if ternary_dist <= _CENSUS_TOL_FRAC and ternary_dist < binary_dist:
                ternary += 1
            elif binary_dist <= _CENSUS_TOL_FRAC:
                binary += 1
        return accents, ternary, binary

    phase = _slot_phase(beat_times_sec, interval_sec)
    window = _ON_BEAT_FRAC * interval_sec
    residuals = []
    for onset, _a in event_accents:
        k = int(round((onset - phase) / interval_sec))
        offset = onset - (phase + k * interval_sec)
        if abs(offset) <= lag_window:
            residuals.append(offset)
    if len(residuals) >= 3:
        phase += sorted(residuals)[len(residuals) // 2]
    k_lo = int(round((beat_times_sec[0] - phase) / interval_sec))
    k_hi = int(round((beat_times_sec[-1] - phase) / interval_sec))
    for onset, accent in event_accents:
        k = int(round((onset - phase) / interval_sec))
        if not k_lo <= k <= k_hi:
            continue
        if abs(onset - (phase + k * interval_sec)) <= window:
            accents[k - k_lo] = max(accents[k - k_lo], accent)
            continue
        frac = ((onset - phase) / interval_sec) % 1.0
        if max_accent > 0 and accent < _CENSUS_MIN_ACCENT_SHARE * max_accent:
            continue
        ternary_dist = min(abs(frac - 1 / 3), abs(frac - 2 / 3))
        binary_dist = abs(frac - 0.5)
        if ternary_dist <= _CENSUS_TOL_FRAC and ternary_dist < binary_dist:
            ternary += 1
        elif binary_dist <= _CENSUS_TOL_FRAC:
            binary += 1
    return accents, ternary, binary


def _period_ratio(accents: list[float], period: int) -> float:
    """Best-phase mean accent at period starts / overall mean."""
    total = sum(accents)
    n = len(accents)
    if total <= 0 or n == 0:
        return 0.0
    best = 0.0
    for phase in range(period):
        vals = accents[phase::period]
        if vals:
            best = max(best, sum(vals) / len(vals))
    return best / (total / n)


def _finish(scores: dict[str, float], *, eighth_level: bool) -> MeterEstimate:
    """Rank candidates, apply the structure threshold, and package.

    'eighth_level' marks that every tracked pulse is an eighth note --
    the caller then anchors 'tracked_unit_ql' on the warp whatever
    the winning label, not only for compound winners.
    """
    ranked = sorted(
        scores.items(), key=lambda kv: (-kv[1], _SORT_PERIOD[kv[0]])
    )
    best_meter, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    if best_score < _MIN_ACCENT_RATIO:
        # No meaningful accent structure at all -- fall back to the
        # common meter and let review decide.
        return _default()
    confidence = (best_score - second_score) / best_score
    return MeterEstimate(
        meter=best_meter,
        confidence=round(min(max(confidence, 0.0), 1.0), 3),
        tracked_eighths=eighth_level and best_meter in _COMPOUND_LABELS,
        uncertain=confidence < UNCERTAIN_CONFIDENCE,
        tracked_unit_ql=_EIGHTH_QL if eighth_level else None,
    )


def _estimate_beat_level(
    beat_times_sec: tuple[float, ...],
    event_accents: tuple[tuple[float, float], ...],
    interval_sec: float,
    variable: bool,
) -> MeterEstimate:
    """Primary-beat tracking: slot accent period + subdivision census.

    The tracker sits on quarter notes (simple meters) or dotted
    quarters (compound meters) -- those share the same period lattice,
    so the census is what separates 6/8 from 2/4 at identical accent
    periods.
    """
    accents, ternary, binary = _slot_evidence(
        beat_times_sec, event_accents, interval_sec, variable
    )
    if not accents or sum(accents) <= 0:
        return _default()

    ternary_ratio = (
        ternary / (ternary + binary)
        if (ternary + binary)
        else _CENSUS_DEFAULT_TERNARY
    )

    ratios = {p: _period_ratio(accents, p) for p in (2, 3, 4, 5)}
    scores = {m: ratios[p] for m, p in _PERIOD_BY_METER.items()}
    factor = _COMPOUND_FACTOR_BASE + _COMPOUND_FACTOR_GAIN * ternary_ratio
    for beats, label in _COMPOUND_BY_BEATS.items():
        # A compound read needs its own accent structure before the
        # census may boost it -- ternary groove alone does not turn a
        # flat period-3 lattice into 9/8.
        scores[label] = (
            ratios[beats] * factor
            if ratios[beats] >= _MIN_ACCENT_RATIO
            else ratios[beats]
        )
    # Candidates need at least three full periods on the grid -- a
    # five-slot window is noise, not evidence of 5/4.
    for meter_label, period in _SORT_PERIOD.items():
        if meter_label in scores and len(accents) < 3 * period:
            scores.pop(meter_label)
    # Period 4 that merely restates the period-2 alternation (6/8's
    # strong/weak pattern) explains nothing extra -- drop both labels
    # built on it so 12/8 cannot tie its way into a coin flip. The
    # symmetric read also applies: when period 4 clearly dominates,
    # the period-2 labels are the redundant ones.
    if ratios[4] <= ratios[2] * _REDUNDANT_PERIOD_TOLERANCE:
        scores.pop("4/4", None)
        scores.pop("12/8", None)
    elif ratios[4] >= ratios[2] * _MIN_ACCENT_RATIO:
        scores.pop("2/4", None)
        scores.pop("6/8", None)
    return _finish(scores, eighth_level=False)


def _estimate_eighth_level(
    beat_times_sec: tuple[float, ...],
    event_accents: tuple[tuple[float, float], ...],
    interval_sec: float,
    variable: bool,
) -> MeterEstimate:
    """Eighth-note pulse: lag accents on the slot grid.

    Same rules as the strengths fallback -- a 6/8 measure shows a
    lag-6 downbeat with a lag-3 mid-bar accent, 9/8 a lag-9 downbeat
    over the lag-3/6 group accents, and so on. A lag-8 read also
    rescues simple 4/4 pieces whose tracker landed on eighths (the
    old estimate mislabelled or mis-anchored them).
    """
    accents, _t, _b = _slot_evidence(
        beat_times_sec, event_accents, interval_sec, variable
    )
    if not accents or sum(accents) <= 0:
        return _default()

    def lag(period: int) -> float:
        return _period_ratio(accents, period)

    n = len(accents)
    lag3, lag4 = lag(3), lag(4)
    lag6, lag7, lag8 = lag(6), lag(7), lag(8)
    lag9, lag12 = lag(9), lag(12)
    scores = {
        m: lag(p)
        for m, p in _PERIOD_BY_METER.items()
        if n >= 3 * p
    }
    if lag6 > _MIN_ACCENT_RATIO and lag3 > 1.0 and lag6 >= lag3 * 1.1:
        scores["6/8"] = lag6
    if (
        lag9 > _MIN_ACCENT_RATIO
        and lag3 > 1.0
        and lag9 >= lag3 * 1.1
        and lag9 >= lag6 * 1.1
    ):
        scores["9/8"] = lag9
    if lag12 > _MIN_ACCENT_RATIO and lag6 > 1.0 and lag12 >= lag6 * 1.1:
        scores["12/8"] = lag12
    if (
        lag7 > _MIN_ACCENT_RATIO
        and lag7 >= lag3
        and lag7 >= lag6
        and lag7 >= lag9
    ):
        scores["7/8"] = lag7
    # 4/4 at eighth resolution: a lag-8 downbeat that clearly beats
    # the half-bar lag-4 read (equal strength is 2/4, not 4/4).
    if lag8 > _MIN_ACCENT_RATIO and lag8 >= lag4 * 1.1 and lag8 >= lag6:
        scores["4/4"] = max(scores["4/4"], lag8)
    return _finish(scores, eighth_level=True)


def _estimate_from_strengths(
    beat_times_sec: tuple[float, ...],
    strengths: tuple[float, ...],
    pulse_bpm: float,
) -> MeterEstimate:
    """Strengths-only fallback -- the pre-#87 estimator, kept as-is.

    The onset envelope at tracked beats is noisy, so this only runs
    when the caller could not supply per-note accents (tests, and
    hypothetically a pipeline without sample access).
    """
    n = len(beat_times_sec)
    if n < _MIN_BEATS or len(strengths) != n or not strengths:
        return _default()
    total = sum(strengths)
    if total <= 0:
        return _default()

    def accent_ratio(period: int) -> float:
        """Best-phase mean strength at measure starts / overall mean."""
        best = 0.0
        for phase in range(period):
            vals = [strengths[i] for i in range(phase, n, period)]
            if not vals:
                continue
            phase_mean = sum(vals) / len(vals)
            if phase_mean > best:
                best = phase_mean
        overall = total / n
        return best / overall if overall > 0 else 0.0

    scores = {m: accent_ratio(_PERIOD_BY_METER[m]) for m in _SIMPLE_PERIODS}

    # Compound + odd meters on an eighth-note pulse (the tracker must
    # be fast enough that eighths were actually tracked; otherwise the
    # lag evidence is an artifact of the wrong pulse level).
    lag3 = accent_ratio(3)
    lag6 = accent_ratio(6)
    lag7 = accent_ratio(7)
    lag9 = accent_ratio(9)
    lag12 = accent_ratio(12)
    if pulse_bpm <= _MAX_EIGHTH_BPM:
        if lag6 > _MIN_ACCENT_RATIO and lag3 > 1.0 and lag6 >= lag3 * 1.1:
            scores["6/8"] = lag6
        if (
            lag9 > _MIN_ACCENT_RATIO
            and lag3 > 1.0
            and lag9 >= lag3 * 1.1
            and lag9 >= lag6 * 1.1
        ):
            scores["9/8"] = lag9
        if lag12 > _MIN_ACCENT_RATIO and lag6 > 1.0 and lag12 >= lag6 * 1.1:
            scores["12/8"] = lag12
        if (
            lag7 > _MIN_ACCENT_RATIO
            and lag7 >= lag3
            and lag7 >= lag6
            and lag7 >= lag9
        ):
            scores["7/8"] = lag7

    est = _finish(scores, eighth_level=False)
    if est.uncertain or est.meter not in _COMPOUND_LABELS:
        return MeterEstimate(
            meter=est.meter,
            confidence=est.confidence,
            tracked_eighths=False,
            uncertain=est.uncertain,
            tracked_unit_ql=None,
        )
    denominator = int(est.meter.split("/")[1])
    return MeterEstimate(
        meter=est.meter,
        confidence=est.confidence,
        tracked_eighths=True,
        uncertain=False,
        tracked_unit_ql=Fraction(4, denominator),
    )
