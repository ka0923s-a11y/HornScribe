"""Quantizer input/output contracts (QUANTIZER_DESIGN.md sections 5 and 41).

Contracts only — the k-best DP search that produces these values lands in
later QNT milestones. The boundary rule that matters here:

* pre-quantization positions (:class:`NormalizedNote`) are ``float``;
* committed quantized positions (:class:`QuantizedRhythmNote`,
  :class:`RhythmAtom`) are exact :class:`~fractions.Fraction` — no float
  drift at quantization boundaries (design 5.4–5.5).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from fractions import Fraction

from hornscribe.domain.ids import RawNoteEventId, ScoreNoteId
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.profile import TripletPolicy

QUANTIZER_ID = "HSQ"
"""Quantizer identifier stored in project persistence (design section 45)."""

QUANTIZER_VERSION = 4
"""HSQ-v1 behavior version; bump when quantization output can change.

2 = QNT-003 joint duration/rest realization (notes carry notation atoms,
alternatives carry realized rests; durations are no longer provisional).
3 = QNT-004 meter-aware runs: meter-map candidate floor, ``pickup_ambiguous``
review reasons, grid-validated ``measure_phase_ql`` (design 22).
4 = QNT-005 triplet model: region-gated triplet candidates/atoms, grid-mode
switch cost, notation-sensitive ambiguity, ``possible_triplet`` reasons.
"""


@dataclass(frozen=True)
class NormalizedNote:
    """A raw event mapped to musical time (design section 5.4).

    Positions are still ``float`` — they become exact ``Fraction`` only when
    the quantizer commits to grid boundaries. ``offset_ql`` is intentionally
    *not* validated against ``onset_ql``: reversed/overlapping raw offsets are
    problem-fixture evidence the quantizer must surface, not crash on (design
    section 38).
    """

    source_id: RawNoteEventId
    pitch_midi: int
    onset_ql: float
    offset_ql: float
    confidence: float | None = None

    def __post_init__(self) -> None:
        if not math.isfinite(self.onset_ql):
            raise ValueError(f"onset_ql must be finite, got {self.onset_ql!r}")
        if not math.isfinite(self.offset_ql):
            raise ValueError(f"offset_ql must be finite, got {self.offset_ql!r}")


@dataclass(frozen=True)
class RhythmAtom:
    """One notatable symbol span (design section 14.1).

    ``duration_ql`` is the exact performed span; ``symbol`` + ``dots`` +
    ``tuplet`` describe how it is written. ``tie_to_next`` joins this atom to
    the following one inside a single note's realization (rests never tie).
    Triple dots are excluded in HSQ-v1, so ``dots <= 2``.
    """

    duration_ql: Fraction
    symbol: str
    """Base symbol name: ``"whole"``, ``"half"``, ``"quarter"``, ``"eighth"``,
    ``"sixteenth"`` (dot/tuplet are separate fields)."""
    dots: int = 0
    tuplet: str | None = None
    """Tuplet label such as ``"triplet"``; the tuplet model lands in QNT-005."""
    is_rest: bool = False
    tie_to_next: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "duration_ql", as_exact_fraction(self.duration_ql, name="duration_ql")
        )
        if self.duration_ql <= 0:
            raise ValueError(f"atom duration_ql must be > 0, got {self.duration_ql}")
        if not self.symbol:
            raise ValueError("atom symbol must be a non-empty string")
        if isinstance(self.dots, bool) or not isinstance(self.dots, int) or not 0 <= self.dots <= 2:
            raise ValueError(f"atom dots must be in 0..2, got {self.dots!r}")
        if self.is_rest and self.tie_to_next:
            raise ValueError("rest atoms cannot tie to the next atom")


@dataclass(frozen=True)
class NotationRealization:
    """Ordered atoms tiling a span — the notation-facing rhythm shape.

    For a note span the atoms are written note symbols joined by ties; for a
    rest span they are separate rests (design section 16).
    """

    atoms: tuple[RhythmAtom, ...]

    def __post_init__(self) -> None:
        atoms = tuple(self.atoms)
        object.__setattr__(self, "atoms", atoms)
        if not atoms:
            raise ValueError("notation realization needs at least one atom")
        for atom in atoms:
            if not isinstance(atom, RhythmAtom):
                raise TypeError(f"expected RhythmAtom, got {atom!r}")

    @property
    def total_ql(self) -> Fraction:
        """Total exact span covered by the atoms."""
        return sum((a.duration_ql for a in self.atoms), Fraction(0))


@dataclass(frozen=True)
class QuantizedRhythmNote:
    """Rhythm result for one canonical note (design section 5.5).

    ``onset_ql``/``duration_ql`` are exact ``Fraction`` quarterLength values —
    the "no float drift at quantization boundaries" contract. ``notation`` is
    the realized atom decomposition when available (QNT-003+); when present
    it must tile exactly ``duration_ql``.
    """

    canonical_note_id: ScoreNoteId
    source_event_ids: tuple[RawNoteEventId, ...]
    onset_ql: Fraction
    duration_ql: Fraction
    notation: NotationRealization | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "onset_ql", as_exact_fraction(self.onset_ql, name="onset_ql"))
        object.__setattr__(
            self, "duration_ql", as_exact_fraction(self.duration_ql, name="duration_ql")
        )
        object.__setattr__(self, "source_event_ids", tuple(self.source_event_ids))
        if self.onset_ql < 0:
            raise ValueError(f"onset_ql must be >= 0, got {self.onset_ql}")
        if self.duration_ql <= 0:
            raise ValueError(f"duration_ql must be > 0, got {self.duration_ql}")
        if self.notation is not None and self.notation.total_ql != self.duration_ql:
            raise ValueError(
                f"notation atoms total {self.notation.total_ql} != duration_ql "
                f"{self.duration_ql}"
            )

    @property
    def end_ql(self) -> Fraction:
        """End of the note span (exclusive)."""
        return self.onset_ql + self.duration_ql


@dataclass(frozen=True)
class RealizedRest:
    """A realized rest span (design sections 12 and 16).

    Rests carry no canonical identity (``ids.py``: rest ``note/@id`` values
    are presentation-only); a rest is fully described by its exact onset and
    the rest-atom decomposition of its span. ``notation`` tiles exactly
    ``duration_ql`` and every atom has ``is_rest=True`` — rest atoms never
    tie (design section 16) and never cross a barline, so a rest covering
    several measures simply contains one atom group per measure.
    """

    onset_ql: Fraction
    notation: NotationRealization

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "onset_ql", as_exact_fraction(self.onset_ql, name="onset_ql")
        )
        if self.onset_ql < 0:
            raise ValueError(f"rest onset_ql must be >= 0, got {self.onset_ql}")
        if not isinstance(self.notation, NotationRealization):
            raise TypeError(
                f"notation must be a NotationRealization, got {self.notation!r}"
            )
        for atom in self.notation.atoms:
            if not atom.is_rest:
                raise ValueError("rest realization atoms must all be rests")

    @property
    def duration_ql(self) -> Fraction:
        """Total exact span covered by the rest atoms."""
        return self.notation.total_ql

    @property
    def end_ql(self) -> Fraction:
        """End of the rest span (exclusive)."""
        return self.onset_ql + self.duration_ql


@dataclass(frozen=True)
class QuantizationDiagnostics:
    """Result metadata for one quantization run (design section 41).

    Defaults describe "no run yet"; the quantizer fills in what it computed.
    ``review_reasons`` carries internal reason strings (design section 40)
    such as ``"quantization_ambiguous"``.
    """

    quantizer_id: str = QUANTIZER_ID
    quantizer_version: int = QUANTIZER_VERSION
    weights_version: int = 0
    meter: str | None = None
    """Primary meter label, e.g. ``"4/4"``."""
    min_note_value_ql: Fraction | None = None
    triplet_policy: TripletPolicy | None = None
    alignment_shift_sec: float = 0.0
    """Global latency shift applied before normalization (design 6.3)."""
    path_cost: float | None = None
    """Total cost of the best path."""
    alternative_cost: float | None = None
    """Total cost of the best runner-up alternative (rank 2)."""
    ambiguous_region_count: int = 0
    symbol_count: int = 0
    """All written symbols: note atoms + rest atoms (design 36.2, 41)."""
    tie_count: int = 0
    rest_count: int = 0
    """Number of written rest *atoms* (a multi-measure gap may split)."""
    tiny_rest_count: int = 0
    tuplet_group_count: int = 0
    second_dot_count: int = 0
    strong_boundary_obscured_count: int = 0
    overlap_clipped_count: int = 0
    """Notes whose raw offset ran past the next onset and were clipped
    (monophonic rule, design 27)."""
    max_overlap_ql: float = 0.0
    """Largest raw-offset overrun past a next onset, retained for
    diagnostics (design 27: "raw overlap amountはdiagnosticsへ保持")."""
    span_realization_calls: int = 0
    """Measure-local span decomposition lookups (design 43 profiling)."""
    span_realization_cache_hits: int = 0
    """Cache hits among those lookups (design 43 memoization)."""
    review_reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "review_reasons", tuple(self.review_reasons))
        if self.min_note_value_ql is not None:
            object.__setattr__(
                self,
                "min_note_value_ql",
                as_exact_fraction(self.min_note_value_ql, name="min_note_value_ql"),
            )
        if self.triplet_policy is not None and not isinstance(
            self.triplet_policy, TripletPolicy
        ):
            raise TypeError(
                f"triplet_policy must be a TripletPolicy, got {self.triplet_policy!r}"
            )
        if not math.isfinite(self.alignment_shift_sec):
            raise ValueError("alignment_shift_sec must be finite")
        if not math.isfinite(self.max_overlap_ql) or self.max_overlap_ql < 0:
            raise ValueError(f"max_overlap_ql must be finite and >= 0, got {self.max_overlap_ql!r}")
        for name in ("path_cost", "alternative_cost"):
            value = getattr(self, name)
            if value is not None and (
                not isinstance(value, (int, float)) or not math.isfinite(value)
            ):
                raise ValueError(f"{name} must be finite or None, got {value!r}")


@dataclass(frozen=True)
class QuantizationAlternative:
    """One ranked quantization hypothesis (design section 5.6).

    ``rank`` is 1-based; ``rank=1`` is the best path. The default run keeps
    ``K = 3`` alternatives (design section 19).
    """

    rank: int
    total_cost: float
    notes: tuple[QuantizedRhythmNote, ...]
    diagnostics: QuantizationDiagnostics = field(default_factory=QuantizationDiagnostics)
    rests: tuple[RealizedRest, ...] = ()
    """Realized rest spans in score order (QNT-003); empty for onset-only
    provisional output (baselines, ``realize_durations=False``)."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "notes", tuple(self.notes))
        object.__setattr__(self, "rests", tuple(self.rests))
        if isinstance(self.rank, bool) or not isinstance(self.rank, int) or self.rank < 1:
            raise ValueError(f"rank must be a positive int, got {self.rank!r}")
        if not math.isfinite(self.total_cost):
            raise ValueError(f"total_cost must be finite, got {self.total_cost!r}")
        for note in self.notes:
            if not isinstance(note, QuantizedRhythmNote):
                raise TypeError(f"expected QuantizedRhythmNote, got {note!r}")
        for rest in self.rests:
            if not isinstance(rest, RealizedRest):
                raise TypeError(f"expected RealizedRest, got {rest!r}")
