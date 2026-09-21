"""Shared score-building helpers for ENG-001 tests."""

from __future__ import annotations

from fractions import Fraction
from typing import Any

from hornscribe.domain.ids import IdAllocator, ScoreNoteId, derive_project_id
from hornscribe.domain.score import (
    KeySignature,
    Part,
    QuantizedNote,
    ScoreDocument,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
)


def make_score(
    notes: list[tuple[int, str | Fraction, str | Fraction]] | None = None,
    *,
    fifths: int = 0,
    mode: str = "major",
    bpm: float = 120.0,
    beats_per_measure: int = 4,
    beat_unit: int = 4,
    pickup_beats: Fraction = Fraction(0),
    part_name: str = "Horn in F",
    title: str = "Test",
    quantization_settings: dict[str, Any] | None = None,
) -> ScoreDocument:
    """Build a canonical concert-pitch score.

    ``notes`` is a list of ``(pitch_midi, start_beat, duration_beats)``;
    canonical IDs are allocated sequentially in the given order.
    """
    if notes is None:
        notes = [(60, 0, 1)]
    alloc = IdAllocator("sn")
    qnotes = tuple(
        QuantizedNote(
            id=ScoreNoteId(alloc.allocate()),
            source_event_ids=(),
            pitch_midi=pitch_midi,
            start_beat=Fraction(start),
            duration_beats=Fraction(duration),
            velocity=80,
        )
        for pitch_midi, start, duration in notes
    )
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=bpm),),
        time_signature=TimeSignature(beats_per_measure, beat_unit),
        key_signature=KeySignature(fifths, mode),
        pickup_beats=pickup_beats,
        parts=(Part(id="part-1", name=part_name, notes=qnotes),),
        quantization_settings=quantization_settings or {"grid": "1/16"},
    )
    return ScoreDocument(
        project_id=derive_project_id({"fixture": "test"}),
        payload=payload,
        title=title,
    )
