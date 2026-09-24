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
from itertools import pairwise
from typing import Any

from hornscribe.domain.events import PitchBendPoint
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
class ScoreAtom:
    """One written symbol inside a canonical note or rest (QNT-006).

    ``duration_beats`` is the atom's exact span on the canonical beat axis;
    ``symbol`` + ``dots`` + ``tuplet`` describe how it is written. These are
    the quantizer's committed notation decisions — HSQ decides the written
    decomposition, the notation layer only renders it (architecture rule:
    music21 realizes/serializes, never re-quantizes).

    ``tie_to_next`` joins this atom to the following atom *inside the same
    canonical note's* atom list; it is always ``False`` on a note's last atom
    and always ``False`` on rest atoms (rests never tie).
    """

    duration_beats: Fraction
    """Exact span of the written symbol (e.g. a triplet eighth = 1/3 beat in
    a quarter-note-beat meter)."""
    symbol: str
    """Base symbol name: ``"whole"``, ``"half"``, ``"quarter"``, ``"eighth"``,
    ``"sixteenth"``, ``"32nd"``, ``"64th"``."""
    dots: int = 0
    tuplet: str | None = None
    """Tuplet label (``"triplet"`` in HSQ-v1), or ``None`` for binary atoms."""
    tuplet_group_start: bool = False
    """``True`` when this atom opens a new visual tuplet group (MusicXML
    ``<tuplet type="start">``); the last tuplet atom before the next
    ``tuplet_group_start``/non-tuplet atom closes it."""
    tie_to_next: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "duration_beats", _unfrac(self.duration_beats))
        if self.duration_beats <= 0:
            raise ValueError(f"atom duration_beats must be > 0, got {self.duration_beats}")
        if not self.symbol:
            raise ValueError("atom symbol must be a non-empty string")
        if (
            isinstance(self.dots, bool)
            or not isinstance(self.dots, int)
            or not 0 <= self.dots <= 2
        ):
            raise ValueError(f"atom dots must be in 0..2, got {self.dots!r}")
        if self.tuplet is not None and not self.tuplet:
            raise ValueError("atom tuplet must be None or a non-empty label")
        if self.tuplet_group_start and self.tuplet is None:
            raise ValueError("tuplet_group_start requires a tuplet atom")

    def to_dict(self) -> dict[str, Any]:
        return {
            "durationBeats": _frac(self.duration_beats),
            "symbol": self.symbol,
            "dots": self.dots,
            "tuplet": self.tuplet,
            "tupletGroupStart": self.tuplet_group_start,
            "tieToNext": self.tie_to_next,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreAtom:
        return cls(
            duration_beats=_unfrac(data["durationBeats"]),
            symbol=str(data["symbol"]),
            dots=int(data.get("dots", 0)),
            tuplet=data.get("tuplet"),
            tuplet_group_start=bool(data.get("tupletGroupStart", False)),
            tie_to_next=bool(data.get("tieToNext", False)),
        )


@dataclass(frozen=True)
class ScoreRest:
    """A realized rest span: start position plus its written rest atoms.

    Rests carry no canonical identity (``ids.py``: rest ``note/@id`` values
    are presentation-only). The atoms tile ``[start_beat, start_beat +
    total)`` exactly, never tie, and never cross a barline — a multi-measure
    rest span contains one atom group per measure (a complete empty measure
    is a single ``"whole"`` atom = the measure-rest convention).
    """

    start_beat: Fraction
    atoms: tuple[ScoreAtom, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_beat", _unfrac(self.start_beat))
        object.__setattr__(self, "atoms", tuple(self.atoms))
        if self.start_beat < 0:
            raise ValueError(f"rest start_beat must be >= 0, got {self.start_beat}")
        if not self.atoms:
            raise ValueError("a rest span needs at least one atom")
        for atom in self.atoms:
            if not isinstance(atom, ScoreAtom):
                raise TypeError(f"expected ScoreAtom, got {atom!r}")
            if atom.tie_to_next:
                raise ValueError("rest atoms cannot tie to the next atom")

    @property
    def duration_beats(self) -> Fraction:
        """Total exact span covered by the rest atoms."""
        return sum((a.duration_beats for a in self.atoms), Fraction(0))

    @property
    def end_beat(self) -> Fraction:
        """End of the rest span (exclusive)."""
        return self.start_beat + self.duration_beats

    def to_dict(self) -> dict[str, Any]:
        return {
            "startBeat": _frac(self.start_beat),
            "atoms": [a.to_dict() for a in self.atoms],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreRest:
        return cls(
            start_beat=_unfrac(data["startBeat"]),
            atoms=tuple(ScoreAtom.from_dict(a) for a in data.get("atoms", ())),
        )


@dataclass(frozen=True)
class QuantizedNote:
    """A canonical score note in rational beat positions.

    ``atoms`` is the optional written decomposition committed by the
    quantizer (QNT-006): when present it tiles ``duration_beats`` exactly,
    every atom but the last carries ``tie_to_next``, and no atom crosses a
    barline (barline/beat splits are already materialized as separate tied
    atoms). When empty the notation layer falls back to deriving the written
    decomposition itself (legacy/provisional scores).
    """

    id: ScoreNoteId
    source_event_ids: tuple[RawNoteEventId, ...]
    pitch_midi: int
    start_beat: Fraction
    duration_beats: Fraction
    velocity: int | None = None
    tie_start: bool = False
    tie_stop: bool = False
    atoms: tuple[ScoreAtom, ...] = ()
    # #174: performed pitch-bend curve carried from the backend evidence,
    # normalized to this note's span (PitchBendPoint.time_sec = 0..1).
    # Omitted from serialization when empty so older payloads keep their
    # content-derived revision ids.
    pitch_bends: tuple[PitchBendPoint, ...] = ()
    # #224: user-deleted note — the canonical record of the UI-050 delete
    # correction. Renders as a rest but keeps its canonical id (ScoreRest
    # cannot: rests carry no identity), so selection/issue links and a
    # later restore survive. Omitted from serialization when False so
    # older payloads keep their content-derived revision ids.
    deleted: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_beat", _unfrac(self.start_beat))
        object.__setattr__(self, "duration_beats", _unfrac(self.duration_beats))
        object.__setattr__(self, "atoms", tuple(self.atoms))
        object.__setattr__(self, "pitch_bends", tuple(self.pitch_bends))
        if self.start_beat < 0:
            raise ValueError(f"start_beat must be >= 0, got {self.start_beat}")
        if self.duration_beats <= 0:
            raise ValueError(f"duration_beats must be > 0, got {self.duration_beats}")
        if self.atoms:
            for atom in self.atoms:
                if not isinstance(atom, ScoreAtom):
                    raise TypeError(f"expected ScoreAtom, got {atom!r}")
            total = sum((a.duration_beats for a in self.atoms), Fraction(0))
            if total != self.duration_beats:
                raise ValueError(
                    f"note atoms total {total} != duration_beats {self.duration_beats}"
                )
            if self.atoms[-1].tie_to_next:
                raise ValueError("a note's last atom cannot tie_to_next")
            for atom in self.atoms[:-1]:
                if not atom.tie_to_next:
                    raise ValueError(
                        "interior atoms of a note must tie to the next atom "
                        "(an untied boundary would read as two notes)"
                    )

    @property
    def end_beat(self) -> Fraction:
        """End of the note span (exclusive)."""
        return self.start_beat + self.duration_beats

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": str(self.id),
            "sourceEventIds": [str(e) for e in self.source_event_ids],
            "pitchMidi": self.pitch_midi,
            "startBeat": _frac(self.start_beat),
            "durationBeats": _frac(self.duration_beats),
            "velocity": self.velocity,
            "tieStart": self.tie_start,
            "tieStop": self.tie_stop,
        }
        # Omitted when absent so pre-QNT-006 payloads keep their derived
        # revision IDs (content-derived identity, ids.py).
        if self.atoms:
            data["atoms"] = [a.to_dict() for a in self.atoms]
        if self.pitch_bends:
            data["pitchBends"] = [b.to_dict() for b in self.pitch_bends]
        if self.deleted:
            data["deleted"] = True
        return data

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
            atoms=tuple(ScoreAtom.from_dict(a) for a in data.get("atoms", ())),
            pitch_bends=tuple(
                PitchBendPoint.from_dict(b) for b in data.get("pitchBends", ())
            ),
            deleted=bool(data.get("deleted", False)),
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
class KeyChange:
    """A key-signature boundary on the canonical beat axis (#133).

    The key_signature is active from start_beat until the next
    change's start_beat (or indefinitely for the last change) —
    the key-map analogue of MeterChange, without a phase concept
    (keys do not affect measure layout).
    """

    start_beat: Fraction
    key_signature: KeySignature

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_beat", _unfrac(self.start_beat))
        if self.start_beat < 0:
            raise ValueError(
                f"key change start_beat must be >= 0, got {self.start_beat}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "startBeat": _frac(self.start_beat),
            "keySignature": self.key_signature.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KeyChange:
        return cls(
            start_beat=_unfrac(data["startBeat"]),
            key_signature=KeySignature.from_dict(data["keySignature"]),
        )


@dataclass(frozen=True)
class MeterChange:
    """A meter segment boundary on the canonical beat axis (QNT-006).

    The meter ``time_signature`` is active from ``start_beat`` until the
    next change's ``start_beat`` (or indefinitely for the last change).
    ``measure_phase_beats`` is the metrical offset of ``start_beat`` inside
    its measure cycle — the mid-piece analogue of ``pickup_beats``: ``0``
    means the change lands on a downbeat; ``p > 0`` means the segment's
    first measure covers only its last ``measure_length - p`` beats.
    """

    start_beat: Fraction
    time_signature: TimeSignature
    measure_phase_beats: Fraction = Fraction(0)

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_beat", _unfrac(self.start_beat))
        object.__setattr__(
            self, "measure_phase_beats", _unfrac(self.measure_phase_beats)
        )
        if self.start_beat < 0:
            raise ValueError(f"meter change start_beat must be >= 0, got {self.start_beat}")
        if self.measure_phase_beats < 0:
            raise ValueError(
                f"measure_phase_beats must be >= 0, got {self.measure_phase_beats}"
            )
        # The upper bound (phase < measure length) needs the canonical beat
        # unit, which only the owning ScoreRevisionPayload knows — it is
        # validated there.

    def to_dict(self) -> dict[str, Any]:
        return {
            "startBeat": _frac(self.start_beat),
            "timeSignature": self.time_signature.to_dict(),
            "measurePhaseBeats": _frac(self.measure_phase_beats),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MeterChange:
        return cls(
            start_beat=_unfrac(data["startBeat"]),
            time_signature=TimeSignature.from_dict(data["timeSignature"]),
            measure_phase_beats=_unfrac(data.get("measurePhaseBeats", "0/1")),
        )


@dataclass(frozen=True)
class Part:
    """A single staff part containing canonical notes in score order.

    ``rests`` is the committed rest list (QNT-006): when non-empty the
    notation layer renders exactly these rest atoms and requires notes+rests
    to tile every measure — no gap-filling. When empty (legacy/provisional
    scores) the notation layer fills inter-note gaps itself.
    """

    id: str
    name: str
    notes: tuple[QuantizedNote, ...] = field(default_factory=tuple)
    rests: tuple[ScoreRest, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        object.__setattr__(self, "notes", tuple(self.notes))
        object.__setattr__(self, "rests", tuple(self.rests))
        ordered = sorted(self.rests, key=lambda r: r.start_beat)
        if tuple(ordered) != self.rests:
            raise ValueError("part rests must be in start_beat order")
        for prev, cur in pairwise(self.rests):
            if cur.start_beat < prev.end_beat:
                raise ValueError(
                    f"overlapping rests: {prev.start_beat}+{prev.duration_beats} "
                    f"vs {cur.start_beat}"
                )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "notes": [n.to_dict() for n in self.notes],
        }
        # Omitted when absent so pre-QNT-006 payloads keep their derived
        # revision IDs.
        if self.rests:
            data["rests"] = [r.to_dict() for r in self.rests]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Part:
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            notes=tuple(QuantizedNote.from_dict(n) for n in data.get("notes", ())),
            rests=tuple(ScoreRest.from_dict(r) for r in data.get("rests", ())),
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

    ``meter_changes`` is the full ordered meter map when the piece changes
    meter (QNT-006); when present it is authoritative for measure layout,
    its first entry must sit at beat ``0`` with ``time_signature`` matching
    the payload's own ``time_signature`` field, and its first
    ``measure_phase_beats`` must agree with ``pickup_beats``. When empty,
    layout derives from ``time_signature`` + ``pickup_beats`` alone (the
    single-meter legacy path).
    """

    tempo_map: tuple[TempoSegment, ...]
    time_signature: TimeSignature
    key_signature: KeySignature
    pickup_beats: Fraction
    parts: tuple[Part, ...]
    quantization_settings: dict[str, Any]
    meter_changes: tuple[MeterChange, ...] = ()
    """#133: key-signature boundaries — mirrors meter_changes (first
    entry at beat 0 carrying the payload key_signature, strictly
    increasing starts). Empty = single-key legacy path."""
    key_changes: tuple[KeyChange, ...] = ()
    """#134: detected swing feel — the offbeat phase (fraction of a
    notated beat) the piece swings to, e.g. 2/3 for a hard shuffle.
    None = straight. Notation renders a swing direction + playback
    hint; the written rhythm itself is left alone."""
    swing_feel: Fraction | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tempo_map", tuple(self.tempo_map))
        object.__setattr__(self, "parts", tuple(self.parts))
        object.__setattr__(self, "meter_changes", tuple(self.meter_changes))
        object.__setattr__(self, "key_changes", tuple(self.key_changes))
        object.__setattr__(self, "pickup_beats", _unfrac(self.pickup_beats))
        if self.swing_feel is not None:
            object.__setattr__(self, "swing_feel", _unfrac(self.swing_feel))
            if not (Fraction(0) < self.swing_feel < Fraction(1)):
                raise ValueError(
                    f"swing_feel must be a beat fraction in (0, 1), got "
                    f"{self.swing_feel}"
                )
        if self.pickup_beats < 0:
            raise ValueError(f"pickup_beats must be >= 0, got {self.pickup_beats}")
        ts0 = self.time_signature
        if ts0.beats_per_measure <= 0 or ts0.beat_unit <= 0:
            raise ValueError(
                f"invalid time signature: {ts0.beats_per_measure}/{ts0.beat_unit}"
            )
        if self.key_changes:
            if self.key_changes[0].start_beat != 0:
                raise ValueError(
                    "first key change must start at beat 0, got "
                    f"{self.key_changes[0].start_beat}"
                )
            if self.key_changes[0].key_signature != self.key_signature:
                raise ValueError(
                    "first key change must carry the payload key_signature: "
                    f"{self.key_changes[0].key_signature} != {self.key_signature}"
                )
            for prev_key, cur_key in pairwise(self.key_changes):
                if cur_key.start_beat <= prev_key.start_beat:
                    raise ValueError(
                        "key changes must be strictly increasing: "
                        f"{prev_key.start_beat} !< {cur_key.start_beat}"
                    )
        if not self.meter_changes:
            # Legacy single-meter path: pickup must fit inside a measure of
            # the (beat-defining) first time signature.
            if self.pickup_beats >= ts0.beats_per_measure:
                raise ValueError(
                    f"pickup_beats {self.pickup_beats} must be shorter than a "
                    f"{ts0.beats_per_measure}-beat measure"
                )
            return
        first = self.meter_changes[0]
        if first.start_beat != 0:
            raise ValueError(
                f"first meter change must start at beat 0, got {first.start_beat}"
            )
        if first.time_signature != ts0:
            raise ValueError(
                "first meter change must carry the payload time_signature: "
                f"{first.time_signature} != {ts0}"
            )
        beat_ql = Fraction(4, ts0.beat_unit)
        expected_phase = (
            Fraction(ts0.beats_per_measure) - self.pickup_beats
            if self.pickup_beats > 0
            else Fraction(0)
        )
        if first.measure_phase_beats != expected_phase:
            raise ValueError(
                f"first meter change phase {first.measure_phase_beats} "
                f"disagrees with pickup_beats {self.pickup_beats} "
                f"(expected {expected_phase})"
            )
        for prev, cur in pairwise(self.meter_changes):
            if cur.start_beat <= prev.start_beat:
                raise ValueError(
                    "meter changes must be strictly increasing: "
                    f"{prev.start_beat} !< {cur.start_beat}"
                )
        for change in self.meter_changes:
            mlen = measure_length_beats(change.time_signature, beat_ql)
            if change.measure_phase_beats >= mlen:
                raise ValueError(
                    f"meter change at {change.start_beat} has phase "
                    f"{change.measure_phase_beats} >= measure length {mlen}"
                )
    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "tempoMap": [t.to_dict() for t in self.tempo_map],
            "timeSignature": self.time_signature.to_dict(),
            "keySignature": self.key_signature.to_dict(),
            "pickupBeats": _frac(self.pickup_beats),
            "parts": [p.to_dict() for p in self.parts],
            "quantizationSettings": self.quantization_settings,
        }
        # Omitted when absent so pre-QNT-006 payloads keep their derived
        # revision IDs.
        if self.meter_changes:
            data["meterChanges"] = [m.to_dict() for m in self.meter_changes]
        if self.key_changes:
            data["keyChanges"] = [k.to_dict() for k in self.key_changes]
        if self.swing_feel is not None:
            data["swingFeel"] = _frac(self.swing_feel)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreRevisionPayload:
        return cls(
            tempo_map=tuple(TempoSegment.from_dict(t) for t in data.get("tempoMap", ())),
            time_signature=TimeSignature.from_dict(data["timeSignature"]),
            key_signature=KeySignature.from_dict(data["keySignature"]),
            pickup_beats=_unfrac(data.get("pickupBeats", "0/1")),
            parts=tuple(Part.from_dict(p) for p in data.get("parts", ())),
            quantization_settings=dict(data.get("quantizationSettings", {})),
            meter_changes=tuple(
                MeterChange.from_dict(m) for m in data.get("meterChanges", ())
            ),
            key_changes=tuple(
                KeyChange.from_dict(k) for k in data.get("keyChanges", ())
            ),
            swing_feel=(
                _unfrac(data["swingFeel"])
                if data.get("swingFeel") is not None
                else None
            ),
        )

    def revision_id(self) -> ScoreRevisionId:
        return derive_score_revision_id(self.to_dict())


def beat_ql_of(payload: ScoreRevisionPayload) -> Fraction:
    """QuarterLength of one canonical beat — set by the first time signature.

    With a single meter this is simply ``4/beat_unit``. With meter changes
    the *first* meter change defines the beat axis for the whole score, so
    positions stay comparable across segment boundaries.
    """
    return Fraction(4, payload.time_signature.beat_unit)


def measure_length_beats(ts: TimeSignature, beat_ql: Fraction) -> Fraction:
    """One measure of *ts* expressed in canonical beats.

    ``ts.beats_per_measure * (4/beat_unit)`` gives the measure length in
    quarterLength; dividing by ``beat_ql`` converts to canonical beats
    (for the beat-defining signature this is just ``beats_per_measure``).
    """
    if ts.beats_per_measure <= 0 or ts.beat_unit <= 0:
        raise ValueError(
            f"invalid time signature: {ts.beats_per_measure}/{ts.beat_unit}"
        )
    return Fraction(ts.beats_per_measure * 4, ts.beat_unit) / beat_ql


def primary_beat_beats(ts: TimeSignature, beat_ql: Fraction) -> Fraction:
    """Length of one primary (felt) beat of *ts* in canonical beats.

    Compound meters (``numerator % 3 == 0 and numerator > 3`` — e.g. 6/8)
    have ``numerator // 3`` dotted beats; simple meters beat on the
    denominator unit. Mirrors ``MeterSegment.beat_unit_ql`` (design 7.3).
    """
    if ts.beats_per_measure <= 0 or ts.beat_unit <= 0:
        raise ValueError(
            f"invalid time signature: {ts.beats_per_measure}/{ts.beat_unit}"
        )
    beat_count = (
        ts.beats_per_measure // 3
        if ts.beats_per_measure % 3 == 0 and ts.beats_per_measure > 3
        else ts.beats_per_measure
    )
    return measure_length_beats(ts, beat_ql) / beat_count


def note_layers(notes: tuple[QuantizedNote, ...]) -> dict[ScoreNoteId, int]:
    """Assign each note a notation layer (voice) within its part (#155).

    Notes sharing ``(start_beat, duration_beats, atoms)`` — the chord
    condition — are chord members and share one layer.  Any other
    overlap needs its own layer: layers are allocated greedily so the
    lowest free layer wins.  Monophonic parts get all-zero layers, so
    this is a strict generalization of the old one-voice-per-part rule.
    """
    groups: dict[tuple[Fraction, Fraction, tuple[ScoreAtom, ...]], list[QuantizedNote]] = {}
    for n in sorted(notes, key=lambda n: (n.start_beat, n.pitch_midi, n.id)):
        groups.setdefault((n.start_beat, n.duration_beats, n.atoms), []).append(n)
    layer_ends: list[Fraction] = []
    out: dict[ScoreNoteId, int] = {}
    for members in groups.values():
        start = members[0].start_beat
        end = members[0].end_beat
        layer = 0
        while layer < len(layer_ends) and layer_ends[layer] > start:
            layer += 1
        if layer == len(layer_ends):
            layer_ends.append(end)
        else:
            layer_ends[layer] = end
        for n in members:
            out[n.id] = layer
    return out


@dataclass(frozen=True)
class MeasureSpan:
    """One measure's span on the canonical beat axis.

    ``number`` is the MusicXML measure number (``0`` for the implicit
    anacrusis measure); ``time_signature`` is the meter active inside the
    measure; ``meter_change`` marks the first measure of a new meter — the
    notation layer emits ``<time>`` attributes there;
    ``cycle_offset_beats`` is the span's position inside its meter's measure
    cycle (``0`` except for the partial first measure of a phased segment).
    """

    number: int
    start_beat: Fraction
    end_beat: Fraction
    time_signature: TimeSignature
    meter_change: bool = False
    implicit: bool = False
    cycle_offset_beats: Fraction = Fraction(0)

    @property
    def duration_beats(self) -> Fraction:
        return self.end_beat - self.start_beat


def measure_spans(payload: ScoreRevisionPayload) -> tuple[MeasureSpan, ...]:
    """Deterministic measure layout shared by every part and every consumer.

    Layout rules (QNT-006):

    * each meter change tiles measures from its ``start_beat`` until the next
      change (or the content end for the last change), each first measure
      shortened by its ``measure_phase_beats``;
    * a meter change that falls inside a previous measure *clips* it — the
      partial measure keeps its number;
    * a ``measure_phase_beats > 0`` on the *first* change is the anacrusis:
      measure ``0`` with ``implicit`` (the existing convention); phased
      mid-piece changes keep regular numbering;
    * every segment emits at least one measure, so a meter declared beyond
      the content end still appears (as an empty measure);
    * with no ``meter_changes`` this degenerates to the historical layout:
      optional implicit pickup measure plus ``beats_per_measure`` tiling.
    """
    changes = payload.meter_changes
    if not changes:
        ts0 = payload.time_signature
        mlen0 = Fraction(ts0.beats_per_measure)
        phase0 = (
            mlen0 - payload.pickup_beats if payload.pickup_beats > 0 else Fraction(0)
        )
        changes = (MeterChange(Fraction(0), ts0, phase0),)
    beat_ql = beat_ql_of(payload)

    end = payload.pickup_beats
    for part in payload.parts:
        for n in part.notes:
            end = max(end, n.end_beat)
        for r in part.rests:
            end = max(end, r.end_beat)

    spans: list[MeasureSpan] = []
    number = 1
    for i, change in enumerate(changes):
        seg_end = changes[i + 1].start_beat if i + 1 < len(changes) else None
        mlen = measure_length_beats(change.time_signature, beat_ql)
        pos = change.start_beat
        first = True
        while first or (pos < seg_end if seg_end is not None else pos < end):
            dur = mlen - change.measure_phase_beats if first else mlen
            m_end = pos + dur
            if seg_end is not None and m_end > seg_end:
                m_end = seg_end
            if m_end <= pos:
                break  # safety: zero-length measure
            implicit = first and i == 0 and change.measure_phase_beats > 0
            span_number = 0 if implicit else number
            if not implicit:
                number += 1
            spans.append(
                MeasureSpan(
                    number=span_number,
                    start_beat=pos,
                    end_beat=m_end,
                    time_signature=change.time_signature,
                    meter_change=first and i > 0,
                    implicit=implicit,
                    cycle_offset_beats=(
                        change.measure_phase_beats if first else Fraction(0)
                    ),
                )
            )
            pos = m_end
            first = False
    return tuple(spans)


@dataclass(frozen=True)
class ScoreDocument:
    """Canonical score container. ``payload`` carries all musical content."""

    project_id: ProjectId
    payload: ScoreRevisionPayload
    title: str = ""
    # #271: notation metadata written into MusicXML/PDF headers —
    # kept outside the payload, so editing them does not churn the
    # content-derived score revision.
    composer: str | None = None
    arranger: str | None = None
    source_audio_path: str | None = None
    source_audio_hash: str | None = None
    transcription_backend: str | None = None
    transcription_backend_version: str | None = None
    transcription_settings: dict[str, Any] = field(default_factory=dict)
    # #223/#226: the raw transcription evidence (cleaned backend events
    # per part + the seconds->ql warp) that produced this score. Kept
    # inline so the project file is self-contained — requantize replays
    # the real performance instead of re-rounding the notation.
    raw_evidence: dict[str, Any] | None = None
    pitch_space: PitchSpace = PitchSpace.CONCERT

    @property
    def revision(self) -> ScoreRevisionId:
        return self.payload.revision_id()

    def to_dict(self) -> dict[str, Any]:
        if self.pitch_space is not PitchSpace.CONCERT:
            raise ValueError("canonical ScoreDocument must be concert pitch")
        out: dict[str, Any] = {
            "projectId": str(self.project_id),
            "revision": str(self.revision),
            "title": self.title,
            "composer": self.composer,
            "arranger": self.arranger,
            "sourceAudioPath": self.source_audio_path,
            "sourceAudioHash": self.source_audio_hash,
            "transcriptionBackend": self.transcription_backend,
            "transcriptionBackendVersion": self.transcription_backend_version,
            "transcriptionSettings": self.transcription_settings,
            "pitchSpace": self.pitch_space.value,
            "content": self.payload.to_dict(),
        }
        if self.raw_evidence is not None:
            out["rawEvidence"] = self.raw_evidence
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreDocument:
        space = PitchSpace(data.get("pitchSpace", "concert"))
        doc = cls(
            project_id=ProjectId(data["projectId"]),
            payload=ScoreRevisionPayload.from_dict(data["content"]),
            title=str(data.get("title", "")),
            composer=(
                data["composer"]
                if isinstance(data.get("composer"), str)
                else None
            ),
            arranger=(
                data["arranger"]
                if isinstance(data.get("arranger"), str)
                else None
            ),
            source_audio_path=data.get("sourceAudioPath"),
            source_audio_hash=data.get("sourceAudioHash"),
            transcription_backend=data.get("transcriptionBackend"),
            transcription_backend_version=data.get("transcriptionBackendVersion"),
            transcription_settings=dict(data.get("transcriptionSettings", {})),
            raw_evidence=(
                dict(data["rawEvidence"])
                if isinstance(data.get("rawEvidence"), dict)
                else None
            ),
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
