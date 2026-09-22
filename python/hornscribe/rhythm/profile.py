"""Quantization profile and cost weights (QUANTIZER_DESIGN.md sections 30–31).

Contracts only — these immutable dataclasses carry the grid/cost
configuration for one HSQ-v1 run. The dynamic-programming search that
consumes them lands in later QNT milestones; no search logic lives here.

Per design section 31 all weight numbers are *starting values* to be tuned
against the benchmark corpus and frozen via ``weights_version`` (design
section 45).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, fields, replace
from enum import Enum
from fractions import Fraction

from hornscribe.rhythm._util import as_exact_fraction


class TripletPolicy(Enum):
    """Triplet candidate policy (design section 17.2).

    Maps to the UI setting ``三連符: 自動 / 使用しない / 候補に含める``.
    """

    AUTO = "auto"
    """Default: region-gated automatic triplet candidacy."""
    NEVER = "never"
    """Triplet candidates are never generated."""
    ALWAYS = "always"
    """Triplet candidates are always included in the grid."""


@dataclass(frozen=True)
class QuantizerWeights:
    """Objective cost weights (design section 31 initial values).

    ``weights_version`` tracks the tuning state so a project can pin the
    exact weight set that produced its score revision (design section 45);
    ``0`` means "pre-freeze starting values".
    """

    onset: float = 4.0
    ioi: float = 2.0
    offset: float = 1.0
    symbol: float = 0.55
    tie: float = 0.45
    first_dot: float = 0.08
    second_dot: float = 0.35
    tuplet_group: float = 1.20
    tuplet_atom: float = 0.12
    mode_switch: float = 0.70
    tiny_rest: float = 0.75
    weak_boundary_crossing: float = 0.90
    strong_boundary_crossing: float = 1.40
    weights_version: int = 0

    def __post_init__(self) -> None:
        for f in fields(self):
            value = getattr(self, f.name)
            if f.name == "weights_version":
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError(
                        f"weights_version must be a non-negative int, got {value!r}"
                    )
            elif not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"weight {f.name} must be finite, got {value!r}")
            elif value < 0:
                raise ValueError(f"weight {f.name} must be >= 0, got {value!r}")


@dataclass(frozen=True)
class QuantizationProfile:
    """Full grid/cost configuration for one quantization run (design 30).

    Immutable by contract: re-quantization with a different profile produces
    a new score revision (CONTRACTS.md section 1).
    """

    min_note_value_ql: Fraction = Fraction(1, 4)
    """Finest binary grid unit; ``Fraction(1, 4)`` = sixteenth note (8.1)."""
    triplet_policy: TripletPolicy = TripletPolicy.AUTO
    k_best: int = 3
    """Number of alternative rhythm hypotheses retained (design 19)."""
    candidate_window_ql: Fraction = Fraction(7, 20)
    """Max onset-candidate distance; ~0.35 ql starting heuristic (8.3)."""
    max_alignment_shift_sec: float = 0.12
    """Half-width of the global latency search band, ±120 ms (6.3)."""
    triplet_gate_min_relevant_onsets: int = 2
    """Triplet-relevant onsets a beat region needs for ``AUTO`` candidacy
    (design 17.2: "region内に2個以上のrelevant onset")."""
    triplet_relevance_margin_ql: float = 0.02
    """How much closer the triplet grid must fit than the binary grid for an
    onset to count as triplet *relevant* evidence (design 17.2)."""
    sigma_onset_ql: float = 0.10
    """Huber scale for onset residuals; starting value, tuned in QNT-007."""
    sigma_ioi_ql: float = 0.10
    """Huber scale for inter-onset-interval residuals; starting value."""
    sigma_offset_ql: float = 0.20
    """Huber scale for offset residuals; offsets are soft evidence (13)."""
    huber_k: float = 1.0
    """Huber loss knee ``k`` (design 9)."""
    weights: QuantizerWeights = field(default_factory=QuantizerWeights)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "min_note_value_ql",
            as_exact_fraction(self.min_note_value_ql, name="min_note_value_ql"),
        )
        object.__setattr__(
            self,
            "candidate_window_ql",
            as_exact_fraction(self.candidate_window_ql, name="candidate_window_ql"),
        )
        if (
            self.min_note_value_ql.numerator != 1
            or self.min_note_value_ql.denominator & (self.min_note_value_ql.denominator - 1)
            or self.min_note_value_ql <= 0
        ):
            raise ValueError(
                "min_note_value_ql must be a unit fraction with power-of-two "
                f"denominator (1/2, 1/4, 1/8, ...), got {self.min_note_value_ql}"
            )
        if self.candidate_window_ql <= 0:
            raise ValueError(
                f"candidate_window_ql must be > 0, got {self.candidate_window_ql}"
            )
        if isinstance(self.k_best, bool) or not isinstance(self.k_best, int) or self.k_best < 1:
            raise ValueError(f"k_best must be a positive int, got {self.k_best!r}")
        if not isinstance(self.triplet_policy, TripletPolicy):
            raise TypeError(
                f"triplet_policy must be a TripletPolicy, got {self.triplet_policy!r}"
            )
        if (
            isinstance(self.triplet_gate_min_relevant_onsets, bool)
            or not isinstance(self.triplet_gate_min_relevant_onsets, int)
            or self.triplet_gate_min_relevant_onsets < 1
        ):
            raise ValueError(
                "triplet_gate_min_relevant_onsets must be a positive int, "
                f"got {self.triplet_gate_min_relevant_onsets!r}"
            )
        for name in (
            "max_alignment_shift_sec",
            "sigma_onset_ql",
            "sigma_ioi_ql",
            "sigma_offset_ql",
            "huber_k",
            "triplet_relevance_margin_ql",
        ):
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{name} must be finite, got {value!r}")
        if self.max_alignment_shift_sec < 0:
            raise ValueError("max_alignment_shift_sec must be >= 0")
        if self.triplet_relevance_margin_ql < 0:
            raise ValueError("triplet_relevance_margin_ql must be >= 0")
        if min(self.sigma_onset_ql, self.sigma_ioi_ql, self.sigma_offset_ql) <= 0:
            raise ValueError("sigma_* values must be > 0")
        if self.huber_k <= 0:
            raise ValueError("huber_k must be > 0")

    @classmethod
    def standard(cls) -> QuantizationProfile:
        """標準 profile: 16th grid, automatic triplets, standard simplicity."""
        return cls()

    @classmethod
    def close_to_performance(cls) -> QuantizationProfile:
        """原演奏に近く: timing fidelity up, complexity penalties down (30).

        Starting values pending benchmark tuning (section 31).
        """
        weights = replace(
            QuantizerWeights(),
            onset=6.0,
            ioi=3.0,
            offset=1.5,
            symbol=0.40,
            tie=0.35,
            first_dot=0.06,
            second_dot=0.25,
            tuplet_group=0.90,
            tuplet_atom=0.09,
            mode_switch=0.50,
            tiny_rest=0.55,
            weak_boundary_crossing=0.65,
            strong_boundary_crossing=1.00,
        )
        return cls(weights=weights, sigma_onset_ql=0.08, sigma_ioi_ql=0.08)

    @classmethod
    def simple(cls) -> QuantizationProfile:
        """簡潔: timing tolerance up, complexity/tiny-rest penalties up (30).

        Starting values pending benchmark tuning (section 31).
        """
        weights = replace(
            QuantizerWeights(),
            onset=3.0,
            ioi=1.5,
            offset=0.75,
            symbol=0.75,
            tie=0.60,
            first_dot=0.12,
            second_dot=0.50,
            tuplet_group=1.60,
            tuplet_atom=0.16,
            mode_switch=0.90,
            tiny_rest=1.10,
            weak_boundary_crossing=1.20,
            strong_boundary_crossing=1.80,
        )
        return cls(
            weights=weights,
            sigma_onset_ql=0.15,
            sigma_ioi_ql=0.15,
            sigma_offset_ql=0.30,
        )
