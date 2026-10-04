"""Quantization output -> canonical ScoreRevisionPayload (ENG-002).

The quantizer speaks quarterLength (``onset_ql``/``duration_ql``,
``RhythmAtom``); the canonical score model speaks *beats* on the axis
defined by the first time signature (``4/beat_unit`` ql per beat) and
``ScoreAtom`` (which adds the ``tuplet_group_start`` marker the
notation layer needs). This module is the single conversion point —
nowhere else should divide by ``beat_ql``.

``tuplet_group_start`` is computed over the *merged* note+rest atom
stream in score order: a group opens on the first tuplet atom after a
non-tuplet atom and stays open until the next non-tuplet atom (the
MusicXML ``<tuplet type="start|stop">`` convention).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from fractions import Fraction
from typing import Any

from hornscribe.domain.events import PitchBendPoint, RawNoteEvent
from hornscribe.domain.ids import (
    ProjectId,
    RawNoteEventId,
    ScoreNoteId,
    derive_project_id,
)
from hornscribe.domain.score import (
    KeyChange,
    KeySignature,
    MeterChange,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
    measure_spans,
    note_layers,
)
from hornscribe.rhythm.contracts import QuantizationAlternative, RhythmAtom
from hornscribe.rhythm.meter import MeterSegment


@dataclass(frozen=True)
class BuiltScore:
    """Everything the job result needs, built once."""

    document: ScoreDocument
    payload: ScoreRevisionPayload
    meter_segment: MeterSegment
    note_confidence: dict[ScoreNoteId, float]
    """Canonical note id -> backend confidence (for review issues)."""
    note_onset_sec: dict[ScoreNoteId, float]
    """Canonical note id -> source seconds (for issue time ranges)."""


def _beat_ql(ts: TimeSignature) -> Fraction:
    return Fraction(4, ts.beat_unit)


def _atom_to_score(atom: RhythmAtom, beat_ql: Fraction, group_start: bool) -> ScoreAtom:
    return ScoreAtom(
        duration_beats=atom.duration_ql / beat_ql,
        symbol=atom.symbol,
        dots=atom.dots,
        tuplet=atom.tuplet,
        tuplet_group_start=group_start,
        tie_to_next=atom.tie_to_next,
    )


def _tuplet_group_starts(atoms: list[RhythmAtom]) -> list[bool]:
    """Mark the first atom of each consecutive tuplet run."""
    flags: list[bool] = []
    in_group = False
    for atom in atoms:
        if atom.tuplet is not None and not in_group:
            flags.append(True)
            in_group = True
        else:
            flags.append(False)
            in_group = atom.tuplet is not None
    return flags


def build_score(
    alternative: QuantizationAlternative,
    meter: MeterSegment,
    tempo_map: tuple[TempoSegment, ...],
    key: KeySignature,
    *,
    pickup_len_ql: Fraction = Fraction(0),
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
    title: str,
    source_audio_path: str,
    source_audio_hash: str | None,
    settings: dict[str, Any],
    project_id: ProjectId | None = None,
    extra_voices: tuple[QuantizationAlternative, ...] = (),
    voice_names: tuple[str, ...] = (),
    merge_voices: bool = False,
    extra_parts: tuple[tuple[str, tuple[QuantizationAlternative, ...]], ...] = (),
    key_changes: tuple[KeyChange, ...] = (),
    swing_feel: Fraction | None = None,
    transcription_backend: str | None = None,
    transcription_backend_version: str | None = None,
) -> BuiltScore:
    """Assemble the canonical payload + document for rank-1 output.

    ``event_by_id`` lets each canonical note recover its backend
    confidence/onset seconds for review-issue evidence.

    extra_voices (#85): additional monophonic streams (voice 2+),
    each quantized against the same meter/tempo. They become extra
    parts on the shared measure layout; canonical note ids are
    renumbered to continue after voice 1's sequence so every sn-*
    stays unique across parts. voice_names overrides the default
    part names ("Horn in F", "Horn in F (2nd voice)", ...).

    merge_voices (#155 chords texture): instead of separate parts,
    every voice's notes merge into part 1 — same-rhythm simultaneities
    become in-part chords, other overlaps become notation layers. Only
    voice 1's rests are kept (canonical rests tile the primary layer;
    secondary layers gap-fill at render time).

    extra_parts (#203/#213): (name, alternatives) groups appended as
    their own parts — the accompaniment staves. Each group merges into
    ONE part the way merge_voices folds part 1: the first
    alternative's notes + rests form layer 0, later voices contribute
    notes only (in-part chords when rhythms align, notation layers
    otherwise), and uncovered layer-0 intervals get synthesized rests
    so the canonical rest contract still tiles every occupied measure.
    """
    ts = meter.time_signature
    beat_ql = _beat_ql(ts)

    notes, rests, confidence, onsets = _part_content(alternative, beat_ql, event_by_id)

    parts: list[Part] = [
        Part(
            id="part-1",
            name=voice_names[0] if voice_names else "Horn in F",
            notes=tuple(notes),
            rests=tuple(rests),
        )
    ]
    next_ordinal = len(notes) + 1
    for vi, voice_alt in enumerate(extra_voices):
        v_notes, v_rests, v_conf, v_onsets = _part_content(voice_alt, beat_ql, event_by_id)
        # The quantizer's sn-* allocator restarts per stream — renumber
        # so canonical ids stay unique across parts (review issues and
        # client edits key on them).
        renumbered: list[QuantizedNote] = []
        for n in v_notes:
            new_id = ScoreNoteId(f"sn-{next_ordinal:06d}")
            next_ordinal += 1
            renumbered.append(replace(n, id=new_id))
            if n.id in v_conf:
                confidence[new_id] = v_conf[n.id]
            if n.id in v_onsets:
                onsets[new_id] = v_onsets[n.id]
        if merge_voices:
            # #155: fold this voice into part 1 — rests stay voice-1's.
            parts[0] = replace(
                parts[0],
                notes=tuple(
                    sorted(
                        (*parts[0].notes, *renumbered),
                        key=lambda n: (n.start_beat, n.pitch_midi, n.id),
                    )
                ),
            )
            continue
        default_name = "Horn in F (2nd voice)" if vi == 0 else f"Horn in F (voice {vi + 2})"
        parts.append(
            Part(
                id=f"part-{vi + 2}",
                name=voice_names[vi + 1] if len(voice_names) > vi + 1 else default_name,
                notes=tuple(renumbered),
                rests=tuple(v_rests),
            )
        )

    # Merged multi-voice parts (folded extra_voices into part 1, and
    # grouped extra_parts) get a layer-0 gap-rest pass below: merged
    # notes can displace voice-1 elements from layer 0 and leave
    # sub-measure holes the strict tiling check rejects.
    merged_part_indexes: list[int] = []
    if merge_voices and extra_voices:
        merged_part_indexes.append(0)
    for p_name, p_alts in extra_parts:
        if not p_alts:
            continue
        merged_notes: list[QuantizedNote] = []
        base_rests: tuple[ScoreRest, ...] = ()
        for ai, alt in enumerate(p_alts):
            p_notes, p_rests, p_conf, p_onsets = _part_content(alt, beat_ql, event_by_id)
            if ai == 0:
                base_rests = tuple(p_rests)
            for n in p_notes:
                new_id = ScoreNoteId(f"sn-{next_ordinal:06d}")
                next_ordinal += 1
                merged_notes.append(replace(n, id=new_id))
                if n.id in p_conf:
                    confidence[new_id] = p_conf[n.id]
                if n.id in p_onsets:
                    onsets[new_id] = p_onsets[n.id]
        merged_notes.sort(key=lambda n: (n.start_beat, n.pitch_midi, n.id))
        if merged_notes or base_rests:
            parts.append(
                Part(
                    id=f"part-{len(parts) + 1}",
                    name=p_name,
                    notes=tuple(merged_notes),
                    rests=base_rests,
                    # Accompaniment staves are not transposing
                    # instruments — a written view must keep them in
                    # the sounding projection.
                    transposing=False,
                )
            )
            if len(p_alts) > 1:
                merged_part_indexes.append(len(parts) - 1)

    # Pickup: the beat-map lift (tempo.py) says how long the anacrusis
    # measure is; the meter segment's phase is its complement inside the
    # measure cycle (phase = L - pickup, 0 when there is no pickup).
    measure_ql = meter.measure_length_ql
    pickup_ql = pickup_len_ql % measure_ql if pickup_len_ql else Fraction(0)
    phase_ql = (measure_ql - pickup_ql) % measure_ql if pickup_ql else Fraction(0)
    pickup_beats = pickup_ql / beat_ql
    phase_beats = phase_ql / beat_ql
    meter_changes = (
        MeterChange(
            start_beat=Fraction(0),
            time_signature=ts,
            measure_phase_beats=phase_beats,
        ),
    )
    payload = ScoreRevisionPayload(
        tempo_map=tempo_map,
        time_signature=ts,
        key_signature=key,
        pickup_beats=pickup_beats,
        parts=tuple(parts),
        quantization_settings=settings,
        meter_changes=meter_changes,
        key_changes=key_changes,
        swing_feel=swing_feel,
    )
    if merged_part_indexes:
        payload = _layer0_gap_rests(payload, tuple(merged_part_indexes))
    document = ScoreDocument(
        project_id=project_id or derive_project_id({"audio": source_audio_path}),
        payload=payload,
        title=title,
        source_audio_path=source_audio_path,
        source_audio_hash=source_audio_hash,
        transcription_backend=transcription_backend,
        transcription_backend_version=transcription_backend_version,
        transcription_settings=settings,
    )
    return BuiltScore(
        document=document,
        payload=payload,
        meter_segment=meter,
        note_confidence=confidence,
        note_onset_sec=onsets,
    )


def _gap_rest(start: Fraction, end: Fraction) -> ScoreRest:
    # One rest of an exact (possibly odd) span: a "whole" atom carries
    # the true duration — inside a partial span the notation layer falls
    # back to a duration-typed rest; a full measure renders as the
    # usual measure rest.
    return ScoreRest(
        start_beat=start,
        atoms=(ScoreAtom(duration_beats=end - start, symbol="whole"),),
    )


def _layer0_gap_rests(
    payload: ScoreRevisionPayload,
    part_indexes: tuple[int, ...],
) -> ScoreRevisionPayload:
    """Fill uncovered layer-0 intervals in merged multi-voice parts.

    Merged parts keep only voice 1's rests, but the layer assignment
    (note_layers) sorts groups by onset/pitch/id, not by voice: a later
    voice's note can take layer 0 under a displaced voice-1 element and
    leave a sub-measure hole — or occupy a measure voice 1 never
    reached.  Both cases break the strict per-measure tiling the
    notation layer verifies, so every uncovered interval inside the
    part's active span gets a synthesized rest.
    """
    spans = measure_spans(payload)
    new_parts = list(payload.parts)
    changed = False
    for part_index in part_indexes:
        part = new_parts[part_index]
        layers = note_layers(tuple(part.notes), part.rests)
        covered = [(r.start_beat, r.end_beat) for r in part.rests]
        covered += [(n.start_beat, n.end_beat) for n in part.notes if layers.get(n.id, 0) == 0]
        if not covered:
            continue
        last_end = max(b for _, b in covered)
        gap_rests: list[ScoreRest] = []
        for span in spans:
            if span.start_beat >= last_end:
                break
            iv = sorted(
                (max(a, span.start_beat), min(b, span.end_beat))
                for a, b in covered
                if a < span.end_beat and b > span.start_beat
            )
            cursor = span.start_beat
            for a, b in iv:
                if a > cursor:
                    gap_rests.append(_gap_rest(cursor, a))
                cursor = max(cursor, b)
            if cursor < span.end_beat:
                gap_rests.append(_gap_rest(cursor, span.end_beat))
        if not gap_rests:
            continue
        rests = tuple(sorted((*part.rests, *gap_rests), key=lambda r: r.start_beat))
        new_parts[part_index] = replace(part, rests=rests)
        changed = True
    if not changed:
        return payload
    return replace(payload, parts=tuple(new_parts))


def _collect_pitch_bends(
    src_events: list[RawNoteEvent],
) -> tuple[PitchBendPoint, ...]:
    """Concatenate source events' bend curves onto one note's 0..1 span.

    Each raw event's points are absolute audio seconds; the canonical
    note's span is the union [min onset, max offset] of its sources, so a
    point's normalized position is (t - span_start) / span. Events
    without bends contribute nothing — a merged note keeps the curve of
    whichever segments actually carried expression.
    """
    bending = [e for e in src_events if e.pitch_bends]
    if not bending:
        return ()
    span_start = min(e.onset_sec for e in src_events)
    span_end = max(e.offset_sec for e in src_events)
    span = span_end - span_start
    if span <= 0:
        return ()
    out: list[PitchBendPoint] = []
    for e in bending:
        for b in e.pitch_bends:
            pos = (b.time_sec - span_start) / span
            out.append(
                PitchBendPoint(
                    time_sec=min(1.0, max(0.0, pos)),
                    bend_semitones=b.bend_semitones,
                )
            )
    out.sort(key=lambda b: b.time_sec)
    return tuple(out)


def _part_content(
    alternative: QuantizationAlternative,
    beat_ql: Fraction,
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
) -> tuple[
    list[QuantizedNote],
    list[ScoreRest],
    dict[ScoreNoteId, float],
    dict[ScoreNoteId, float],
]:
    """Notes + rests + evidence maps for one voice's alternative.

    The merged atom stream (notes + rests interleaved by onset, score
    order) gets tuplet group flags across the whole stream so a group
    spanning a rest boundary is still bracketed correctly.
    """
    stream: list[RhythmAtom] = []
    note_atom_ranges: list[tuple[int, int]] = [(0, 0)] * len(alternative.notes)
    rest_atom_ranges: list[tuple[int, int]] = [(0, 0)] * len(alternative.rests)
    ordered: list[tuple[Fraction, str, int]] = [
        (n.onset_ql, "note", i) for i, n in enumerate(alternative.notes)
    ] + [(r.onset_ql, "rest", i) for i, r in enumerate(alternative.rests)]
    ordered.sort(key=lambda e: e[0])
    for _pos_ql, kind, i in ordered:
        if kind == "note":
            notation = alternative.notes[i].notation
        else:
            notation = alternative.rests[i].notation
        atoms = notation.atoms if notation is not None else ()
        start = len(stream)
        stream.extend(atoms)
        if kind == "note":
            note_atom_ranges[i] = (start, len(stream))
        else:
            rest_atom_ranges[i] = (start, len(stream))
    group_flags = _tuplet_group_starts(stream)

    notes: list[QuantizedNote] = []
    confidence: dict[ScoreNoteId, float] = {}
    onsets: dict[ScoreNoteId, float] = {}
    for i, qn in enumerate(alternative.notes):
        lo, hi = note_atom_ranges[i]
        score_atoms = tuple(
            _atom_to_score(a, beat_ql, group_flags[lo + j]) for j, a in enumerate(stream[lo:hi])
        )
        src_events = [event_by_id[e] for e in qn.source_event_ids if e in event_by_id]
        conf = max((e.confidence for e in src_events if e.confidence is not None), default=None)
        # Merged notes keep the strongest source velocity (mirrors the
        # confidence max above): the first segment is not always the
        # performed attack.
        velocity = max(
            (e.velocity for e in src_events if e.velocity is not None),
            default=None,
        )
        # #174: carry the performed bend curve onto the canonical note,
        # normalized to the note's audio span (0..1) so consumers that
        # only know the score span (MIDI ticks, audition ms) can place
        # each point. Merged notes concatenate their segments' curves.
        pitch_bends = _collect_pitch_bends(src_events)
        notes.append(
            QuantizedNote(
                id=qn.canonical_note_id,
                source_event_ids=qn.source_event_ids,
                pitch_midi=int(round(src_events[0].pitch_midi)) if src_events else 60,
                start_beat=qn.onset_ql / beat_ql,
                duration_beats=qn.duration_ql / beat_ql,
                velocity=velocity,
                atoms=score_atoms,
                pitch_bends=pitch_bends,
            )
        )
        if conf is not None:
            confidence[qn.canonical_note_id] = conf
        if src_events:
            onsets[qn.canonical_note_id] = src_events[0].onset_sec

    rests = [
        ScoreRest(
            start_beat=r.onset_ql / beat_ql,
            atoms=tuple(
                _atom_to_score(a, beat_ql, group_flags[lo + j]) for j, a in enumerate(stream[lo:hi])
            ),
        )
        for r, (lo, hi) in zip(alternative.rests, rest_atom_ranges, strict=True)
    ]
    return notes, rests, confidence, onsets
