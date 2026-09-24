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

from hornscribe.domain.events import RawNoteEvent
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
    key_changes: tuple[KeyChange, ...] = (),
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
    """
    ts = meter.time_signature
    beat_ql = _beat_ql(ts)

    notes, rests, confidence, onsets = _part_content(
        alternative, beat_ql, event_by_id
    )

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
        v_notes, v_rests, v_conf, v_onsets = _part_content(
            voice_alt, beat_ql, event_by_id
        )
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
        default_name = (
            "Horn in F (2nd voice)"
            if vi == 0
            else f"Horn in F (voice {vi + 2})"
        )
        parts.append(
            Part(
                id=f"part-{vi + 2}",
                name=voice_names[vi + 1] if len(voice_names) > vi + 1 else default_name,
                notes=tuple(renumbered),
                rests=tuple(v_rests),
            )
        )

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
    )
    document = ScoreDocument(
        project_id=project_id or derive_project_id({"audio": source_audio_path}),
        payload=payload,
        title=title,
        source_audio_path=source_audio_path,
        source_audio_hash=source_audio_hash,
        transcription_backend="basic_pitch",
        transcription_backend_version="0.4.0",
        transcription_settings=settings,
    )
    return BuiltScore(
        document=document,
        payload=payload,
        meter_segment=meter,
        note_confidence=confidence,
        note_onset_sec=onsets,
    )


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
            _atom_to_score(a, beat_ql, group_flags[lo + j])
            for j, a in enumerate(stream[lo:hi])
        )
        src_events = [event_by_id[e] for e in qn.source_event_ids if e in event_by_id]
        conf = (
            max((e.confidence for e in src_events if e.confidence is not None),
                default=None)
        )
        # Merged notes keep the strongest source velocity (mirrors the
        # confidence max above): the first segment is not always the
        # performed attack.
        velocity = max(
            (e.velocity for e in src_events if e.velocity is not None),
            default=None,
        )
        notes.append(
            QuantizedNote(
                id=qn.canonical_note_id,
                source_event_ids=qn.source_event_ids,
                pitch_midi=int(round(src_events[0].pitch_midi))
                if src_events
                else 60,
                start_beat=qn.onset_ql / beat_ql,
                duration_beats=qn.duration_ql / beat_ql,
                velocity=velocity,
                atoms=score_atoms,
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
                _atom_to_score(a, beat_ql, group_flags[lo + j])
                for j, a in enumerate(stream[lo:hi])
            ),
        )
        for r, (lo, hi) in zip(alternative.rests, rest_atom_ranges, strict=True)
    ]
    return notes, rests, confidence, onsets
