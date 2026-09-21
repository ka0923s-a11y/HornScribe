"""Timing-fidelity costs for the HSQ onset search (QUANTIZER_DESIGN.md 9-10).

All timing residuals are scaled by their Huber ``sigma`` before the loss is
applied, so a single ``huber_k`` knee governs every term:

* :func:`onset_cost` — ``w_i * weights.onset * Huber((q_i - x_i) /
  sigma_onset)`` (design 10.1). ``w_i`` is a narrow confidence modulation in
  ``[0.8, 1.2]``; confidence is *timing evidence weight*, never a
  probability.
* :func:`ioi_cost` — ``weights.ioi * Huber(((q_i - q_{i-1}) - (x_i -
  x_{i-1})) / sigma_ioi)`` (design 10.2). Penalizing the *change* in onset
  error preserves neighbor rhythm patterns that independent snapping
  destroys; set ``weights.ioi = 0`` for the no-IOI ablation.

Huber loss (design 9) keeps expressive deviation and AMT outliers from
dominating the path:

    rho(r) = 0.5 r^2          if |r| <= k
             k (|r| - 0.5 k)  otherwise
"""

from __future__ import annotations

import math
from fractions import Fraction

from hornscribe.rhythm.contracts import NormalizedNote
from hornscribe.rhythm.lattice import OnsetCandidate
from hornscribe.rhythm.profile import QuantizationProfile

#: Confidence modulation bounds (design 10.1: ``0.8 <= w_i <= 1.2``).
_CONFIDENCE_WEIGHT_MIN = 0.8
_CONFIDENCE_WEIGHT_MAX = 1.2


def huber(residual: float, k: float = 1.0) -> float:
    """Huber loss ``rho(residual)`` with knee ``k`` (design 9).

    Quadratic for ``|r| <= k``, linear beyond it — outliers add linear, not
    quadratic, cost. ``k`` must be positive.
    """
    if not math.isfinite(residual) or not math.isfinite(k) or k <= 0:
        raise ValueError(f"huber residual={residual!r} k={k!r}")
    r = abs(residual)
    if r <= k:
        return 0.5 * r * r
    return k * (r - 0.5 * k)


def confidence_weight(confidence: float | None) -> float:
    """Timing-evidence weight in ``[0.8, 1.2]`` (design 10.1).

    ``None`` (no backend confidence) maps to the neutral ``1.0``; otherwise
    ``w = 0.8 + 0.4 * confidence`` — a deliberately narrow modulation, never
    a probability.
    """
    if confidence is None:
        return 1.0
    if not math.isfinite(confidence):
        raise ValueError(f"confidence must be finite or None, got {confidence!r}")
    w = _CONFIDENCE_WEIGHT_MIN + (_CONFIDENCE_WEIGHT_MAX - _CONFIDENCE_WEIGHT_MIN) * min(
        max(confidence, 0.0), 1.0
    )
    return min(max(w, _CONFIDENCE_WEIGHT_MIN), _CONFIDENCE_WEIGHT_MAX)


def onset_cost(
    candidate: OnsetCandidate, note: NormalizedNote, profile: QuantizationProfile
) -> float:
    """Weighted Huber onset residual for one candidate (design 10.1)."""
    weight = profile.weights.onset
    if weight == 0.0:
        return 0.0
    residual = (float(candidate.position_ql) - note.onset_ql) / profile.sigma_onset_ql
    return confidence_weight(note.confidence) * weight * huber(residual, profile.huber_k)


def ioi_cost(
    prev_pos_ql: Fraction,
    curr_pos_ql: Fraction,
    prev_note: NormalizedNote,
    curr_note: NormalizedNote,
    profile: QuantizationProfile,
) -> float:
    """Weighted Huber inter-onset-interval residual for a transition (10.2).

    The residual is the *change* in onset error across the transition —
    ``(q_i - q_{i-1}) - (x_i - x_{i-1})`` — so globally consistent timing
    error (e.g. uniform latency) is not re-penalized here.
    """
    weight = profile.weights.ioi
    if weight == 0.0:
        return 0.0
    quantized_ioi = float(curr_pos_ql - prev_pos_ql)
    observed_ioi = curr_note.onset_ql - prev_note.onset_ql
    residual = (quantized_ioi - observed_ioi) / profile.sigma_ioi_ql
    return weight * huber(residual, profile.huber_k)
