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

from hornscribe.domain.ids import IdAllocator, derive_project_id
from hornscribe.domain.score import (
    KeySignature,
    MeterChange,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    measure_spans,
)
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.contracts import (
    QUANTIZER_ID,
    QUANTIZER_VERSION,
    NormalizedNote,
    QuantizationAlternative,
    QuantizedRhythmNote,
    RealizedRest,
    RhythmAtom,
)
from hornscribe.rhythm.lattice import snap_to_grid_ql
from hornscribe.rhythm.meter import MeterMap
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


def _atoms_to_score(
    atoms: tuple[RhythmAtom, ...],
    start_ql: Fraction,
    beat_ql: Fraction,
    meter_map: MeterMap,
) -> tuple[ScoreAtom, ...]:
    """Project one committed atom list onto the beat axis.

    ``tuplet_group_start`` reproduces the realizer's visual-group rule
    (``realize._decompose_piece``: a new group starts when the previous atom
    was not a triplet, when the atom sits on a triplet-region start, or at a
    piece boundary). Regions are beat-aligned, so "atom start is a beat
    start of its segment" is equivalent to "region start" for triplet atoms:
    a triplet atom can only begin inside an enabled region, and a region
    containing a beat-aligned start begins there. Piece boundaries are
    barlines (always beat starts) or meter changes (a triplet atom can only
    begin there when the boundary is a beat start of the new segment).
    """
    out: list[ScoreAtom] = []
    prev_tuplet = False
    pos = start_ql
    for atom in atoms:
        group_start = False
        if atom.tuplet is not None:
            segment = meter_map.segment_at(pos)
            beat_aligned = (
                pos - segment.start_ql + segment.measure_phase_ql
            ) % segment.beat_unit_ql == 0
            group_start = (not prev_tuplet) or beat_aligned
        out.append(
            ScoreAtom(
                duration_beats=atom.duration_ql / beat_ql,
                symbol=atom.symbol,
                dots=atom.dots,
                tuplet=atom.tuplet,
                tuplet_group_start=group_start,
                tie_to_next=atom.tie_to_next,
            )
        )
        prev_tuplet = atom.tuplet is not None
        pos += atom.duration_ql
    return tuple(out)


def assemble_score_document(
    alternative: QuantizationAlternative,
    notes: Sequence[NormalizedNote],
    meter_map: MeterMap,
    *,
    bpm: float = 120.0,
    fifths: int = 0,
    mode: str = "major",
    part_name: str = "Horn in F",
    title: str = "",
) -> ScoreDocument:
    """Lift a quantization alternative into a canonical :class:`ScoreDocument`.

    QNT-006 realization->score bridge (issue #20): the alternative's
    committed :class:`QuantizedRhythmNote` records become canonical
    :class:`QuantizedNote` records — canonical note IDs and
    ``source_event_ids`` are preserved so review linkage survives — and the
    committed atom decomposition (interior ties, barline splits, triplet
    atoms) is carried verbatim as ``QuantizedNote.atoms`` so the notation
    layer renders HSQ's decisions instead of re-deriving them (architecture
    rule: HSQ decides onset/duration/rest/tie/tuplet intent; the notation
    backend only realizes/serializes).

    Beat axis: the *first* meter segment's denominator defines the canonical
    beat unit (``beat_ql = 4/denominator`` — eighth-note beats when the
    piece starts in 6/8) and the first segment's ``start_ql`` normalizes to
    beat ``0``. Mid-piece meter changes land in ``payload.meter_changes``
    with each segment's ``measure_phase_ql`` preserved in beats; the first
    segment's phase continues to surface as ``pickup_beats`` (measure ``0``
    with ``implicit="yes"``, design section 22).

    ``alternative.rests`` become canonical :class:`ScoreRest` records on the
    part; the notation layer then renders exactly those atoms and requires
    complete measure tiling. When the meter map declares a segment beyond
    the content end, the bridge appends whole-rest atoms up to the last
    emitted measure so the score tiles to the final barline.

    Pitches come from the ``notes`` evidence via ``source_event_ids``.
    Provisional alternatives (``notation=None``, no rests — the timing-only
    ablation output) still lift: notes carry no atoms and the notation layer
    falls back to gap-filling, matching the pre-QNT-006 behavior.
    """
    if not meter_map.segments:
        raise ValueError("meter_map needs at least one segment")
    segment = meter_map.segments[0]
    beat_ql = Fraction(4, segment.denominator)
    pitch_by_event = {str(n.source_id): n.pitch_midi for n in notes}

    ordered = sorted(
        alternative.notes, key=lambda n: (n.onset_ql, str(n.canonical_note_id))
    )
    qnotes: list[QuantizedNote] = []
    for n in ordered:
        if not n.source_event_ids:
            raise ValueError(
                f"quantized note {n.canonical_note_id} has no source events"
            )
        src = str(n.source_event_ids[0])
        if src not in pitch_by_event:
            raise ValueError(
                f"quantized note {n.canonical_note_id} source event {src} is "
                "not in the supplied notes"
            )
        if n.onset_ql < segment.start_ql:
            raise ValueError(
                f"quantized note {n.canonical_note_id} onset {n.onset_ql} "
                f"precedes the meter map start {segment.start_ql}"
            )
        atoms = (
            _atoms_to_score(n.notation.atoms, n.onset_ql, beat_ql, meter_map)
            if n.notation is not None
            else ()
        )
        qnotes.append(
            QuantizedNote(
                id=n.canonical_note_id,
                source_event_ids=n.source_event_ids,
                pitch_midi=int(pitch_by_event[src]),
                start_beat=(n.onset_ql - segment.start_ql) / beat_ql,
                duration_beats=n.duration_ql / beat_ql,
                atoms=atoms,
            )
        )

    rests: list[ScoreRest] = [
        ScoreRest(
            start_beat=(r.onset_ql - segment.start_ql) / beat_ql,
            atoms=_atoms_to_score(
                r.notation.atoms, r.onset_ql, beat_ql, meter_map
            ),
        )
        for r in alternative.rests
    ]

    meter_changes = (
        tuple(
            MeterChange(
                start_beat=(s.start_ql - segment.start_ql) / beat_ql,
                time_signature=s.time_signature,
                measure_phase_beats=s.measure_phase_ql / beat_ql,
            )
            for s in meter_map.segments
        )
        if len(meter_map.segments) > 1
        else ()
    )

    step = alternative.diagnostics.min_note_value_ql or Fraction(1, 4)
    denom = Fraction(4) / step  # ql step -> note-value denominator ("1/16")
    grid_name = f"1/{denom.numerator}" if denom.denominator == 1 else f"{step}ql"

    def _payload(part: Part) -> ScoreRevisionPayload:
        return ScoreRevisionPayload(
            tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=bpm),),
            time_signature=segment.time_signature,
            key_signature=KeySignature(fifths, mode),
            pickup_beats=segment.pickup_length_ql / beat_ql,
            parts=(part,),
            quantization_settings={
                "grid": grid_name,
                "quantizer": QUANTIZER_ID,
                "quantizerVersion": QUANTIZER_VERSION,
            },
            meter_changes=meter_changes,
        )

    part = Part(id="part-1", name=part_name, notes=tuple(qnotes), rests=tuple(rests))
    payload = _payload(part)

    if rests:
        # Realized output tiles every touched measure; extend coverage with
        # one measure-rest atom per trailing empty measure so the score also
        # tiles to the layout end — including meter segments declared beyond
        # the last note (each still emits a measure for its signature).
        covered = max(
            [n.end_beat for n in qnotes] + [r.end_beat for r in rests],
            default=Fraction(0),
        )
        spans = measure_spans(payload)
        layout_end = spans[-1].end_beat
        if layout_end > covered:
            boundaries = {s.start_beat for s in spans}
            if covered not in boundaries:
                raise ValueError(
                    f"realized coverage ends at {covered}, which is not a "
                    "measure boundary"
                )
            gap_atoms = tuple(
                ScoreAtom(duration_beats=s.duration_beats, symbol="whole")
                for s in spans
                if s.start_beat >= covered
            )
            rests.append(ScoreRest(start_beat=covered, atoms=gap_atoms))
            part = Part(
                id="part-1", name=part_name, notes=tuple(qnotes), rests=tuple(rests)
            )
            payload = _payload(part)

    return ScoreDocument(
        project_id=derive_project_id({"score": payload.to_dict()}),
        payload=payload,
        title=title,
    )
