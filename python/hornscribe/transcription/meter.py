"""Meter (time signature) estimation for the auto path (ENG-002).

The beat tracker gives pulse times; ``librosa.onset.onset_strength``
evaluated at those times approximates accent. A measure is the span
where the first position is disproportionately strong, so each
candidate period N (2, 3, 4 beats) is scored by the best-phase mean
strength at positions ``i mod N == 0``. 6/8 is a different question —
it asks whether the tracked pulse subdivides into threes — so it is
scored on the lag-3 accent ratio instead of competing with the simple
meters directly.

Confidence is the margin between the best and runner-up score. Low
confidence never fails the job: the caller falls back to 4/4 and
surfaces a ``meter_conflict`` review issue so the user can override.
"""

from __future__ import annotations

from dataclasses import dataclass

_SIMPLE_PERIODS = ("2/4", "3/4", "4/4")
_PERIOD_BY_METER = {"2/4": 2, "3/4": 3, "4/4": 4}

# Minimum beats before we trust the accent evidence at all.
_MIN_BEATS = 8
# Confidence below this -> caller flags a meter_conflict review issue.
UNCERTAIN_CONFIDENCE = 0.2
# Eighth-note pulse faster than this means the tracker is almost
# certainly on the dotted-quarter level, so 6/8 evidence at lag 3 is
# meaningless (the eighths were never tracked).
_MAX_EIGHTH_BPM = 320.0


@dataclass(frozen=True)
class MeterEstimate:
    """Auto-meter outcome for one transcription run."""

    meter: str
    """Chosen time signature label (one of the HSQ-v1 supported set)."""
    confidence: float
    """0..1 margin of the winner over the runner-up (0 = degenerate)."""
    tracked_eighths: bool
    """True when the tracked pulse should anchor eighth-note positions
    (6/8); False anchors primary beats."""
    uncertain: bool
    """True when evidence was too weak to trust — surface a review
    issue and let the user override."""


def estimate_meter(
    beat_times_sec: tuple[float, ...],
    strengths: tuple[float, ...],
) -> MeterEstimate:
    """Pick the best-supported meter from beat-aligned onset strengths.

    ``strengths`` is onset strength sampled at each beat time (parallel
    to ``beat_times_sec``). Fewer than ``_MIN_BEATS`` beats or a flat
    strength curve yields a low-confidence 4/4 default.
    """
    n = len(beat_times_sec)
    if n < _MIN_BEATS or len(strengths) != n or not strengths:
        return MeterEstimate(
            meter="4/4", confidence=0.0, tracked_eighths=False,
            uncertain=True,
        )
    total = sum(strengths)
    if total <= 0:
        return MeterEstimate(
            meter="4/4", confidence=0.0, tracked_eighths=False,
            uncertain=True,
        )

    intervals = [
        b - a for a, b in zip(beat_times_sec, beat_times_sec[1:], strict=False)
    ]
    intervals = [d for d in intervals if d > 0]
    median_sec = sorted(intervals)[len(intervals) // 2] if intervals else 0.5
    pulse_bpm = 60.0 / median_sec

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

    # 6/8: strong accents at lag 6 (measure) AND a *secondary* accent at
    # lag 3 (the mid-bar dotted-quarter). lag6 must clearly exceed lag3
    # — equal strength is just 3/4 read at the wrong level. The tracker
    # must also be on the eighth-note pulse (judged by rate), else the
    # lag-3 evidence is an artifact of the wrong pulse level.
    lag3 = accent_ratio(3)
    lag6 = accent_ratio(6)
    if (
        pulse_bpm <= _MAX_EIGHTH_BPM
        and lag6 > 1.15
        and lag3 > 1.0
        and lag6 >= lag3 * 1.1
    ):
        scores["6/8"] = lag6

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_meter, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = (
        (best_score - second_score) / best_score if best_score > 0 else 0.0
    )
    if best_score < 1.15:
        # No meaningful accent structure at all — fall back to the
        # common meter and let review decide.
        return MeterEstimate(
            meter="4/4", confidence=0.0, tracked_eighths=False,
            uncertain=True,
        )
    uncertain = confidence < UNCERTAIN_CONFIDENCE
    return MeterEstimate(
        meter=best_meter,
        confidence=round(min(max(confidence, 0.0), 1.0), 3),
        tracked_eighths=best_meter == "6/8",
        uncertain=uncertain,
    )
