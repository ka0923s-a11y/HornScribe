"""Raw transcription evidence (FND-001).

RawNoteEvent objects are immutable backend-output evidence. They are never
mutated by cleanup/quantization; downstream artifacts reference them by ID.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId


@dataclass(frozen=True)
class PitchBendPoint:
    """A single pitch-bend sample relative to a note, in seconds and semitones."""

    time_sec: float
    bend_semitones: float

    def to_dict(self) -> dict[str, Any]:
        return {"timeSec": self.time_sec, "bendSemitones": self.bend_semitones}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PitchBendPoint:
        return cls(time_sec=float(data["timeSec"]), bend_semitones=float(data["bendSemitones"]))


@dataclass(frozen=True)
class RawNoteEvent:
    """One note hypothesis emitted by a transcription backend.

    ``pitch_midi`` is a float so backends that report fractional pitch
    (e.g. with bend applied) round-trip losslessly.
    """

    id: RawNoteEventId
    transcription_revision: TranscriptionRevisionId
    pitch_midi: float
    onset_sec: float
    offset_sec: float
    confidence: float | None = None
    velocity: int | None = None
    source: str | None = None
    pitch_bends: tuple[PitchBendPoint, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "transcriptionRevision": str(self.transcription_revision),
            "pitchMidi": self.pitch_midi,
            "onsetSec": self.onset_sec,
            "offsetSec": self.offset_sec,
            "confidence": self.confidence,
            "velocity": self.velocity,
            "source": self.source,
            "pitchBends": [b.to_dict() for b in self.pitch_bends],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RawNoteEvent:
        return cls(
            id=RawNoteEventId(data["id"]),
            transcription_revision=TranscriptionRevisionId(data["transcriptionRevision"]),
            pitch_midi=float(data["pitchMidi"]),
            onset_sec=float(data["onsetSec"]),
            offset_sec=float(data["offsetSec"]),
            confidence=data.get("confidence"),
            velocity=data.get("velocity"),
            source=data.get("source"),
            pitch_bends=tuple(PitchBendPoint.from_dict(b) for b in data.get("pitchBends", ())),
        )
