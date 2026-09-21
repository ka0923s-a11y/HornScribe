"""Shared assembly of quantizer outputs.

Both the HSQ DP and the naive baselines emit the same
:class:`~hornscribe.rhythm.QuantizedRhythmNote` contract, so note assembly —
canonical ID allocation, provisional duration, monotonic repair — lives in
one place.

Provisional duration rule (used only when duration realization is disabled —
the QNT-003 joint transition realization is the default, design 12/33):

* non-final notes span to the next quantized onset: ``duration_i =
  q_{i+1} - q_i`` — always positive because positions are strictly
  increasing;
* the final note snaps its observed duration ``offset_ql - onset_ql`` to the
  grid (ties to the earlier point), clamped to at least one grid step —
  reversed/degenerate raw offsets fall back to one step (design 38 problem
  fixtures must not crash the quantizer).

With realization enabled, :func:`assemble_realized_notes` commits each
interval's chosen note span + notation atoms, and :func:`assemble_path_rests`
materializes the leading/inter-interval/trailing rests so every touched
measure's note+rest atoms tile it exactly.

Provisional durations are placeholders that keep the output contract valid;
raw timing is never written back to source events — raw timing is immutable
evidence (design principle 8).
"""

from __future__ import annotations

from collections.abc import Sequence
from fractions import Fraction

from hornscribe.domain.ids import IdAllocator
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import (
    NormalizedNote,
    QuantizedRhythmNote,
    RealizedRest,
)
from hornscribe.rhythm.lattice import snap_to_grid_ql
from hornscribe.rhythm.realize import IntervalRealization, SpanRealizer


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


def assemble_realized_notes(
    notes: tuple[NormalizedNote, ...],
    positions: tuple[Fraction, ...],
    realizations: tuple[IntervalRealization, ...],
) -> tuple[QuantizedRhythmNote, ...]:
    """Build :class:`QuantizedRhythmNote` results for one realized path.

    Each note's ``duration_ql`` is its chosen *note span* ``[p, e)`` — the
    sounding written duration, which may end before the next onset when the
    realization chose a rest (design 12). ``notation`` carries the atom
    decomposition including barline/beat-split ties (design 15-16).
    ``realizations[i]`` must be the interval starting at ``positions[i]``.
    """
    if not (len(notes) == len(positions) == len(realizations)):
        raise ValueError(
            f"notes/positions/realizations length mismatch: "
            f"{len(notes)} != {len(positions)} != {len(realizations)}"
        )
    allocator = IdAllocator("sn")
    out: list[QuantizedRhythmNote] = []
    for note, pos, rlz in zip(notes, positions, realizations, strict=True):
        if rlz.start_ql != pos:
            raise ValueError(
                f"realization start {rlz.start_ql} does not match path onset {pos}"
            )
        out.append(
            QuantizedRhythmNote(
                canonical_note_id=allocator.allocate_score_note_id(),
                source_event_ids=(note.source_id,),
                onset_ql=pos,
                duration_ql=rlz.note_end_ql - pos,
                notation=rlz.note,
            )
        )
    return tuple(out)


def assemble_path_rests(
    positions: tuple[Fraction, ...],
    realizations: tuple[IntervalRealization, ...],
    realizer: SpanRealizer,
) -> tuple[tuple[RealizedRest, ...], int]:
    """Materialize all rest spans for one committed path.

    Coverage runs from the meter map's origin to the end of the measure
    containing the last note's end, so every touched measure's note+rest
    atoms tile it exactly (issue acceptance: measure-duration invariants):

    * a leading rest fills ``[score_start, first_onset)`` — including
      whole-rest atoms for completely empty leading measures;
    * each interval's chosen rest span fills the gap before the next onset;
    * a trailing rest fills the final measure up to its barline (none when
      the last note ends exactly on a barline — no empty measure is created).

    Returns ``(rests, extra_strong_boundary_obscured)`` where the count
    aggregates obscured-strong-boundary penalties of the leading/trailing
    spans (inter-interval spans already carry theirs on the
    :class:`IntervalRealization` objects).
    """
    if not positions:
        return (), 0
    rests: list[RealizedRest] = []
    extra_strong = 0

    score_start = realizer.score_start_ql
    first = positions[0]
    if first > score_start:
        leading = realizer.realize_span(score_start, first, is_rest=True)
        rests.append(
            RealizedRest(onset_ql=score_start, notation=leading.notation)
        )
        extra_strong += leading.strong_boundary_obscured

    for rlz in realizations:
        if rlz.rest is not None:
            rests.append(
                RealizedRest(onset_ql=rlz.note_end_ql, notation=rlz.rest)
            )

    last_end = realizations[-1].note_end_ql
    if not realizer.is_measure_boundary(last_end):
        measure_end = realizer.next_measure_boundary(last_end)
        trailing = realizer.realize_span(last_end, measure_end, is_rest=True)
        rests.append(
            RealizedRest(onset_ql=last_end, notation=trailing.notation)
        )
        extra_strong += trailing.strong_boundary_obscured

    rests.sort(key=lambda r: r.onset_ql)
    return tuple(rests), extra_strong
