"""Optional B2 baseline: ``music21.Stream.quantize`` (QUANTIZER_DESIGN.md 2.1, 37).

This wrapper exists **only for benchmark comparison** — music21 is the
notation backend (design 34), never the product quantization decision-maker.
It is intentionally *not* re-exported from ``hornscribe.rhythm`` and loads
music21 lazily via ``importlib`` at call time, so the core package stays
stdlib-only (see ``test_rhythm_imports_no_audio_or_gui_dependencies``) and
type-checking never traverses the heavy notation dependency.

music21 quantizes offsets (and optionally durations) onto a fixed grid of
``quarterLength`` divisors; the returned positions are floats/Fractions that
this wrapper re-snaps onto the profile grid to satisfy the exact-Fraction
output contract. That final snap is documented approximation — the baseline
is for onset-error comparison, not authoritative conversion.
"""

from __future__ import annotations

from collections.abc import Sequence
from fractions import Fraction
from importlib import import_module
from typing import Any

from hornscribe.domain.ids import IdAllocator
from hornscribe.rhythm._output import (
    assemble_quantized_notes,
    monotonic_positions,
    onset_sorted,
)
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import NormalizedNote, QuantizedRhythmNote
from hornscribe.rhythm.lattice import snap_to_grid_ql


def _music21() -> Any:
    """Lazily load music21 (main dependency, optional-baseline use only)."""
    return import_module("music21")


def quantize_with_music21(
    notes: Sequence[NormalizedNote],
    *,
    quarter_length_divisors: tuple[int, ...] = (4,),
    snap_grid_ql: Fraction = Fraction(1, 4),
    process_durations: bool = True,
) -> tuple[QuantizedRhythmNote, ...]:
    """Quantize normalized note onsets via ``Stream.quantize`` (B2).

    ``quarter_length_divisors`` mirrors the music21 argument: ``(4,)``
    subdivides the quarter into 4 → a sixteenth-note grid, matching B0/B1.
    Emitted onsets are re-snapped to ``snap_grid_ql`` so results satisfy the
    exact-Fraction output contract, and monotonicity is repaired identically
    to the other baselines.

    ``process_durations`` (default on, QNT-007) additionally lets music21
    quantize each note's written duration — the strongest fair B2: it can
    then answer note-value questions, but it still emits no rests, ties or
    notation atoms (``Stream.quantize`` does not insert rests), so the
    notation-complexity metrics stay ``None``.
    """
    m21 = _music21()

    grid = as_exact_fraction(snap_grid_ql, name="snap_grid_ql")
    if grid <= 0:
        raise ValueError(f"snap_grid_ql must be > 0, got {grid}")
    ordered = onset_sorted(tuple(notes))
    if not ordered:
        return ()

    stream = m21.stream.Stream()
    for note in ordered:
        el = m21.note.Note(note.pitch_midi)
        el.duration.quarterLength = max(note.offset_ql - note.onset_ql, float(grid))
        stream.insert(float(note.onset_ql), el)
    stream.quantize(
        quarterLengthDivisors=list(quarter_length_divisors),
        processOffsets=True,
        processDurations=process_durations,
        inPlace=True,
    )

    quantized = sorted(stream.recurse().notes, key=lambda el: float(el.offset))
    snapped = tuple(snap_to_grid_ql(float(el.offset), grid) for el in quantized)
    positions = monotonic_positions(snapped, grid)
    if not process_durations or len(quantized) != len(ordered):
        return assemble_quantized_notes(ordered, positions, grid)

    # Carry music21's quantized durations (re-snapped to the contract grid,
    # clamped to at least one step) instead of provisional spans.
    allocator = IdAllocator("sn")
    out: list[QuantizedRhythmNote] = []
    for note, pos, el in zip(ordered, positions, quantized, strict=True):
        duration = snap_to_grid_ql(float(el.duration.quarterLength), grid, minimum=grid)
        out.append(
            QuantizedRhythmNote(
                canonical_note_id=allocator.allocate_score_note_id(),
                source_event_ids=(note.source_id,),
                onset_ql=pos,
                duration_ql=duration,
            )
        )
    return tuple(out)
