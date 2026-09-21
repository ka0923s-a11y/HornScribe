"""Canonical score model (FND-001).

A ScoreDocument is *concert pitch only*. Horn in F is a derived presentation
of the same canonical notes and therefore shares canonical note IDs.

Timing model: score positions are rational beat positions (Fraction), never
float seconds. Source seconds are reachable only through the tempo map /
provenance layer.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import Enum
from fractions import Fraction
from typing import Any

from hornscribe.domain.ids import (
    ProjectId,
    RawNoteEventId,
    ScoreNoteId,
    ScoreRevisionId,
    derive_score_revision_id,
)


class PitchSpace(Enum):
    """The only pitch space allowed for canonical storage is CONCERT."""

    CONCERT = "concert"
    WRITTEN_HORN_F = "written_horn_f"  # presentation/export only, never canonical


@dataclass(frozen=True)
class QuantizedNote:
    """A canonical score note in rational beat positions."""

    id: ScoreNoteId
    source_event_ids: tuple[RawNoteEventId, ...]
    pitch_midi: int
    start_beat: Fraction
    duration_beats: Fraction
    velocity: int | None = None
    tie_start: bool = False
    tie_stop: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "sourceEventIds": [str(e) for e in self.source_event_ids],
            "pitchMidi": self.pitch_midi,
            "startBeat": _frac(self.start_beat),
            "durationBeats": _frac(self.duration_beats),
            "velocity": self.velocity,
            "tieStart": self.tie_start,
            "tieStop": self.tie_stop,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> QuantizedNote:
        return cls(
            id=ScoreNoteId(data["id"]),
            source_event_ids=tuple(RawNoteEventId(e) for e in data.get("sourceEventIds", ())),
            pitch_midi=int(data["pitchMidi"]),
            start_beat=_unfrac(data["startBeat"]),
            duration_beats=_unfrac(data["durationBeats"]),
            velocity=data.get("velocity"),
            tie_start=bool(data.get("tieStart", False)),
            tie_stop=bool(data.get("tieStop", False)),
        )


@dataclass(frozen=True)
class TempoSegment:
    start_beat: Fraction
    bpm: float

    def to_dict(self) -> dict[str, Any]:
        return {"startBeat": _frac(self.start_beat), "bpm": self.bpm}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TempoSegment:
        return cls(start_beat=_unfrac(data["startBeat"]), bpm=float(data["bpm"]))


@dataclass(frozen=True)
class TimeSignature:
    beats_per_measure: int
    beat_unit: int

    def to_dict(self) -> dict[str, Any]:
        return {"beatsPerMeasure": self.beats_per_measure, "beatUnit": self.beat_unit}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TimeSignature:
        return cls(
            beats_per_measure=int(data["beatsPerMeasure"]),
            beat_unit=int(data["beatUnit"]),
        )


@dataclass(frozen=True)
class KeySignature:
    """Fifths (-7..7) plus mode."""

    fifths: int
    mode: str = "major"

    def to_dict(self) -> dict[str, Any]:
        return {"fifths": self.fifths, "mode": self.mode}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KeySignature:
        return cls(fifths=int(data["fifths"]), mode=str(data.get("mode", "major")))


@dataclass(frozen=True)
class Part:
    """A single staff part containing canonical notes in score order."""

    id: str
    name: str
    notes: tuple[QuantizedNote, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "notes": [n.to_dict() for n in self.notes]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Part:
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            notes=tuple(QuantizedNote.from_dict(n) for n in data.get("notes", ())),
        )


def _frac(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


def _unfrac(value: Any) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, str):
        return Fraction(value)
    return Fraction(value)


@dataclass(frozen=True)
class ScoreRevisionPayload:
    """The canonical content a score revision ID is derived from.

    Anything that changes the *musical content* of the score belongs here so
    that revision IDs track content, not serialization accidents.
    """

    tempo_map: tuple[TempoSegment, ...]
    time_signature: TimeSignature
    key_signature: KeySignature
    pickup_beats: Fraction
    parts: tuple[Part, ...]
    quantization_settings: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "tempoMap": [t.to_dict() for t in self.tempo_map],
            "timeSignature": self.time_signature.to_dict(),
            "keySignature": self.key_signature.to_dict(),
            "pickupBeats": _frac(self.pickup_beats),
            "parts": [p.to_dict() for p in self.parts],
            "quantizationSettings": self.quantization_settings,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreRevisionPayload:
        return cls(
            tempo_map=tuple(TempoSegment.from_dict(t) for t in data.get("tempoMap", ())),
            time_signature=TimeSignature.from_dict(data["timeSignature"]),
            key_signature=KeySignature.from_dict(data["keySignature"]),
            pickup_beats=_unfrac(data.get("pickupBeats", "0/1")),
            parts=tuple(Part.from_dict(p) for p in data.get("parts", ())),
            quantization_settings=dict(data.get("quantizationSettings", {})),
        )

    def revision_id(self) -> ScoreRevisionId:
        return derive_score_revision_id(self.to_dict())


@dataclass(frozen=True)
class ScoreDocument:
    """Canonical score container. ``payload`` carries all musical content."""

    project_id: ProjectId
    payload: ScoreRevisionPayload
    title: str = ""
    source_audio_path: str | None = None
    source_audio_hash: str | None = None
    transcription_backend: str | None = None
    transcription_backend_version: str | None = None
    transcription_settings: dict[str, Any] = field(default_factory=dict)
    pitch_space: PitchSpace = PitchSpace.CONCERT

    @property
    def revision(self) -> ScoreRevisionId:
        return self.payload.revision_id()

    def to_dict(self) -> dict[str, Any]:
        if self.pitch_space is not PitchSpace.CONCERT:
            raise ValueError("canonical ScoreDocument must be concert pitch")
        return {
            "projectId": str(self.project_id),
            "revision": str(self.revision),
            "title": self.title,
            "sourceAudioPath": self.source_audio_path,
            "sourceAudioHash": self.source_audio_hash,
            "transcriptionBackend": self.transcription_backend,
            "transcriptionBackendVersion": self.transcription_backend_version,
            "transcriptionSettings": self.transcription_settings,
            "pitchSpace": self.pitch_space.value,
            "content": self.payload.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreDocument:
        space = PitchSpace(data.get("pitchSpace", "concert"))
        doc = cls(
            project_id=ProjectId(data["projectId"]),
            payload=ScoreRevisionPayload.from_dict(data["content"]),
            title=str(data.get("title", "")),
            source_audio_path=data.get("sourceAudioPath"),
            source_audio_hash=data.get("sourceAudioHash"),
            transcription_backend=data.get("transcriptionBackend"),
            transcription_backend_version=data.get("transcriptionBackendVersion"),
            transcription_settings=dict(data.get("transcriptionSettings", {})),
            pitch_space=space,
        )
        declared = data.get("revision")
        if declared is not None and declared != str(doc.revision):
            raise ValueError(
                f"score revision mismatch: declared {declared} != derived {doc.revision}"
            )
        return doc


def new_project_id() -> ProjectId:
    """Random project ID for genuinely new projects (creation-time only)."""
    from hornscribe.domain.ids import derive_project_id

    return derive_project_id({"uuid": uuid.uuid4().hex})
