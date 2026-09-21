"""Shared assembly of quantizer outputs (QNT-002 onset phase).

Both the HSQ DP and the naive baselines emit the same
:class:`~hornscribe.rhythm.QuantizedRhythmNote` contract, so note assembly —
canonical ID allocation, provisional duration, monotonic repair — lives in
one place.

Provisional duration rule (no duration/rest realization yet — that is the
QNT-003 joint transition realization, design 12/33):

* non-final notes span to the next quantized onset: ``duration_i =
  q_{i+1} - q_i`` — always positive because positions are strictly
  increasing;
* the final note snaps its observed duration ``offset_ql - onset_ql`` to the
  grid (ties to the earlier point), clamped to at least one grid step —
  reversed/degenerate raw offsets fall back to one step (design 38 problem
  fixtures must not crash the quantizer).

Durations here are placeholders that keep the output contract valid; they
are never written back to source events — raw timing is immutable evidence
(design principle 8).
"""

from __future__ import annotations

from collections.abc import Sequence
from fractions import Fraction

from hornscribe.domain.ids import IdAllocator
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import NormalizedNote, QuantizedRhythmNote
from hornscribe.rhythm.lattice import snap_to_grid_ql


def onset_sorted(notes: Sequence[NormalizedNote]) -> tuple[NormalizedNote, ...]:
    """Onset order with a deterministic tie-break on the source event ID."""
    return tuple(sorted(notes, key=lambda n: (n.onset_ql, str(n.source_id))))


def monotonic_positions(
    positions: tuple[Fraction, ...], step_ql: Fraction
) -> tuple[Fraction, ...]:
    """Repair a position sequence to be strictly increasing.

    Independent snapping (baselines, DP-fallback) can produce equal or
    regressive positions; each offender is nudged forward to ``prev +
    step_ql`` in input order. The result always satisfies the monotonic
    output contract.
    """
    step = as_exact_fraction(step_ql, name="step_ql")
    if step <= 0:
        raise ValueError(f"step_ql must be > 0, got {step}")
    out: list[Fraction] = []
    for pos in positions:
        p = as_exact_fraction(pos, name="pos")
        if out and p <= out[-1]:
            p = out[-1] + step
        out.append(p)
    return tuple(out)


def assemble_quantized_notes(
    notes: tuple[NormalizedNote, ...],
    positions: tuple[Fraction, ...],
    min_note_value_ql: Fraction,
) -> tuple[QuantizedRhythmNote, ...]:
    """Build :class:`QuantizedRhythmNote` results for one onset path.

    Canonical IDs ``sn-000001...`` are allocated in note order, identical for
    every alternative of a run — alternatives are hypotheses about the *same*
    canonical notes. ``notation`` stays ``None`` until joint duration/rest
    realization lands (QNT-003).
    """
    if len(notes) != len(positions):
        raise ValueError(
            f"notes/positions length mismatch: {len(notes)} != {len(positions)}"
        )
    step = as_exact_fraction(min_note_value_ql, name="min_note_value_ql")
    if step <= 0:
        raise ValueError(f"min_note_value_ql must be > 0, got {step}")
    allocator = IdAllocator("sn")
    out: list[QuantizedRhythmNote] = []
    for i, (note, pos) in enumerate(zip(notes, positions, strict=True)):
        if i + 1 < len(positions):
            duration = positions[i + 1] - pos
        else:
            raw = note.offset_ql - float(pos)
            duration = snap_to_grid_ql(raw, step, minimum=step)
        out.append(
            QuantizedRhythmNote(
                canonical_note_id=allocator.allocate_score_note_id(),
                source_event_ids=(note.source_id,),
                onset_ql=pos,
                duration_ql=duration,
            )
        )
    return tuple(out)
