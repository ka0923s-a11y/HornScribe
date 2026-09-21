"""Naive quantization baselines B0/B1 (QUANTIZER_DESIGN.md 3.1, 37).

These exist for benchmark comparison only — they are deliberately *not* the
product quantizer. Both snap each onset independently (no DP, no IOI, no
global consistency), then repair the result to satisfy the monotonic-output
contract so the same metrics and output types apply.

* **B0** :func:`snap_nearest_grid` — nearest sixteenth, always a fixed
  ``1/4 ql`` grid regardless of profile (design 37, "B0 — Nearest 16th").
* **B1** :func:`snap_candidate_lattice` — nearest position of the same
  binary candidate lattice the HSQ DP searches (design 37, "B1 — nearest
  binary candidate grid"); respects the profile's ``min_note_value_ql``.

Tie-break for both: a onset exactly between two grid points snaps to the
*earlier* point, matching the HSQ lexical-position rule (design 44).
"""

from __future__ import annotations

from collections.abc import Sequence
from fractions import Fraction

from hornscribe.rhythm._output import (
    assemble_quantized_notes,
    monotonic_positions,
    onset_sorted,
)
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import NormalizedNote, QuantizedRhythmNote
from hornscribe.rhythm.lattice import generate_onset_candidates, snap_to_grid_ql
from hornscribe.rhythm.profile import QuantizationProfile

#: B0 grid: sixteenth note, fixed (design 37).
BASELINE_B0_GRID_QL = Fraction(1, 4)


def snap_nearest_grid(
    notes: Sequence[NormalizedNote],
    *,
    grid_ql: Fraction = BASELINE_B0_GRID_QL,
) -> tuple[QuantizedRhythmNote, ...]:
    """B0 — independent nearest-grid snap on a fixed grid (design 3.1, 37).

    Each onset rounds to the nearest ``grid_ql`` multiple (ties to the
    earlier point, clamped at ``0``); a forward pass then enforces strictly
    increasing positions by nudging offenders to the next grid point.
    Durations are provisional spans to the next onset (no realization yet).
    """
    grid = as_exact_fraction(grid_ql, name="grid_ql")
    if grid <= 0:
        raise ValueError(f"grid_ql must be > 0, got {grid}")
    ordered = onset_sorted(tuple(notes))
    snapped = tuple(snap_to_grid_ql(note.onset_ql, grid) for note in ordered)
    positions = monotonic_positions(snapped, grid)
    return assemble_quantized_notes(ordered, positions, grid)


def snap_candidate_lattice(
    notes: Sequence[NormalizedNote],
    profile: QuantizationProfile | None = None,
) -> tuple[QuantizedRhythmNote, ...]:
    """B1 — independent nearest *candidate-lattice* snap (design 37).

    Uses the same lattice generator as the HSQ DP (profile
    ``min_note_value_ql`` + candidate window), then picks each note's
    nearest candidate with no neighbor context — isolating the value of the
    global DP in benchmarks.
    """
    profile = profile if profile is not None else QuantizationProfile.standard()
    ordered = onset_sorted(tuple(notes))
    step = profile.min_note_value_ql
    snapped = tuple(
        # Candidates arrive sorted by position but were ranked nearest-first;
        # the minimum-distance candidate is the independent snap choice.
        min(
            generate_onset_candidates(note, profile),
            key=lambda c: (c.distance_ql, c.position_ql),
        ).position_ql
        for note in ordered
    )
    positions = monotonic_positions(snapped, step)
    return assemble_quantized_notes(ordered, positions, step)
