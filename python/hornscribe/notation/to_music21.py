"""Render a canonical :class:`ScoreDocument` into a music21 stream.

HornScribe domain objects stay authoritative; this module only *renders*
them into ``music21`` objects so that music21 can carry the engraving-level
MusicXML details (dev plan §13).  Every pitched ``music21`` note is tagged
with its deterministic MusicXML export ID (:func:`musicxml_note_id`) before
serialization, so emitted ``note/@id`` values always trace back to canonical
identity.

Responsibilities:

* measure construction from the canonical time signature / pickup beats
* splitting notes that cross barlines into tied fragments
* inserting rests for gaps inside measures
* written-pitch projection for the Horn in F presentation
  (``PitchSpace.WRITTEN_HORN_F``), including the transposed key signature
  and the ``instrument.Horn`` that produces ``<transpose>-4/-7`` metadata
* tempo map -> ``MetronomeMark`` placement

Non-responsibilities: enharmonic respelling beyond music21's defaults
(dev plan §11 keeps that as a later, user-adjustable stage).
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from music21 import clef, instrument, key, metadata, meter, note, pitch, stream, tempo, tie
from music21.stream import enums as stream_enums

from hornscribe.domain.ids import musicxml_note_id
from hornscribe.domain.score import (
    PitchSpace,
    QuantizedNote,
    ScoreDocument,
    ScoreRevisionPayload,
)
from hornscribe.instruments import horn_f


class NotationError(ValueError):
    """Canonical content that cannot be rendered into MVP notation."""


@dataclass(frozen=True)
class _MeasureSpan:
    """One measure's span in canonical beats."""

    number: int  # 0 = pickup measure (implicit), else 1-based
    start_beat: Fraction
    end_beat: Fraction
    implicit: bool = False

    @property
    def duration_beats(self) -> Fraction:
        return self.end_beat - self.start_beat


def _beat_ql(payload: ScoreRevisionPayload) -> Fraction:
    """Quarter-note length of one canonical beat."""
    return Fraction(4, payload.time_signature.beat_unit)


def _measure_length_beats(payload: ScoreRevisionPayload) -> Fraction:
    ts = payload.time_signature
    if ts.beats_per_measure <= 0 or ts.beat_unit <= 0:
        raise NotationError(f"invalid time signature: {ts.beats_per_measure}/{ts.beat_unit}")
    return Fraction(ts.beats_per_measure)


def _content_end_beat(payload: ScoreRevisionPayload) -> Fraction:
    end = payload.pickup_beats
    for part in payload.parts:
        for n in part.notes:
            end = max(end, n.start_beat + n.duration_beats)
    return end


def _measure_spans(payload: ScoreRevisionPayload) -> list[_MeasureSpan]:
    """Deterministic measure layout shared by every part.

    With ``pickup_beats > 0`` the first measure is number 0 (implicit) and
    spans ``[0, pickup)``; numbered measures then tile full bars.  Without a
    pickup, measures 1..N tile from beat 0.  Always emits at least one
    measure.
    """
    mlen = _measure_length_beats(payload)
    pickup = payload.pickup_beats
    if pickup < 0:
        raise NotationError(f"negative pickupBeats: {pickup}")
    end = _content_end_beat(payload)

    spans: list[_MeasureSpan] = []
    if pickup > 0:
        spans.append(_MeasureSpan(0, Fraction(0), pickup, implicit=True))
        if end <= pickup:
            return spans
        n_full = -(-(end - pickup) // mlen)  # ceil
        for k in range(1, int(n_full) + 1):
            start = pickup + (k - 1) * mlen
            spans.append(_MeasureSpan(k, start, start + mlen))
        return spans

    n_full = max(1, int(-(-end // mlen)))  # ceil, at least 1
    for k in range(1, n_full + 1):
        start = (k - 1) * mlen
        spans.append(_MeasureSpan(k, start, start + mlen))
    return spans


def _tie_for(piece_index: int, piece_count: int, note_: QuantizedNote) -> tie.Tie | None:
    """Tie for one emitted fragment of a canonical note.

    ``tie_stop`` on the canonical note = incoming tie on the *first*
    fragment; ``tie_start`` = outgoing tie on the *last* fragment.
    Fragments produced by barline splits tie to each other; interior
    fragments use ``continue`` (exported as stop+start).
    """
    tie_in = piece_index > 0 or note_.tie_stop
    tie_out = piece_index < piece_count - 1 or note_.tie_start
    if tie_in and tie_out:
        return tie.Tie("continue")
    if tie_in:
        return tie.Tie("stop")
    if tie_out:
        return tie.Tie("start")
    return None


def _note_pieces(
    note_: QuantizedNote, spans: list[_MeasureSpan]
) -> list[tuple[int, Fraction, Fraction]]:
    """Split a canonical note into ``(span_index, local_offset_beats, dur_beats)``."""
    start = note_.start_beat
    end = start + note_.duration_beats
    if start < 0 or note_.duration_beats <= 0:
        raise NotationError(
            f"note {note_.id} has invalid start/duration: {start}+{note_.duration_beats}"
        )
    pieces: list[tuple[int, Fraction, Fraction]] = []
    for idx, span in enumerate(spans):
        if span.end_beat <= start:
            continue
        if span.start_beat >= end:
            break
        piece_start = max(start, span.start_beat)
        piece_end = min(end, span.end_beat)
        if piece_end > piece_start:
            pieces.append((idx, piece_start - span.start_beat, piece_end - piece_start))
    if not pieces:
        raise NotationError(f"note {note_.id} does not overlap any measure")
    return pieces


def _check_monophonic(notes: tuple[QuantizedNote, ...]) -> None:
    """MVP renders one voice per part; overlapping onsets are rejected."""
    ordered = sorted(notes, key=lambda n: (n.start_beat, n.id))
    prev_end: Fraction | None = None
    prev_id: str | None = None
    for n in ordered:
        if prev_end is not None and n.start_beat < prev_end:
            raise NotationError(
                f"overlapping notes in one part are unsupported: {prev_id} ends at "
                f"{prev_end} but {n.id} starts at {n.start_beat}"
            )
        prev_end = n.start_beat + n.duration_beats
        prev_id = str(n.id)


def _build_part_measures(
    payload: ScoreRevisionPayload,
    part_notes: list[QuantizedNote],
    part_name: str,
    spans: list[_MeasureSpan],
    presentation: PitchSpace,
) -> stream.Part:
    beat_ql = _beat_ql(payload)
    part = stream.Part()
    part.partName = part_name
    if presentation is PitchSpace.WRITTEN_HORN_F:
        part.insert(0, instrument.Horn())

    tempo_marks: dict[int, list[tuple[Fraction, tempo.MetronomeMark]]] = {}
    for seg in payload.tempo_map:
        mark = tempo.MetronomeMark(number=seg.bpm)
        for idx, span in enumerate(spans):
            if span.start_beat <= seg.start_beat < span.end_beat:
                tempo_marks.setdefault(idx, []).append((seg.start_beat - span.start_beat, mark))
                break
        else:
            # Segment begins at/after the content end: keep the tempo
            # change by anchoring it to the end of the final measure.
            tempo_marks.setdefault(len(spans) - 1, []).append(
                (spans[-1].duration_beats, mark)
            )

    # Split every canonical note into measure-bound fragments once.
    pieces_by_measure: dict[int, list[tuple[QuantizedNote, int, int, Fraction, Fraction]]] = {}
    for n in part_notes:
        pieces = _note_pieces(n, spans)
        for pidx, (sidx, local_start, dur) in enumerate(pieces):
            pieces_by_measure.setdefault(sidx, []).append((n, pidx, len(pieces), local_start, dur))

    for idx, span in enumerate(spans):
        measure = stream.Measure(number=span.number)
        if span.implicit:
            # music21 maps MusicXML implicit="yes" to showNumber=NEVER.
            measure.showNumber = stream_enums.ShowNumber.NEVER

        if idx == 0:
            ks = payload.key_signature
            if presentation is PitchSpace.WRITTEN_HORN_F:
                ks = horn_f.written_key_signature(ks)
            measure.insert(0, key.KeySignature(ks.fifths))
            ts = payload.time_signature
            measure.insert(0, meter.TimeSignature(f"{ts.beats_per_measure}/{ts.beat_unit}"))
            measure.insert(0, clef.TrebleClef())

        for local_beat, mark in tempo_marks.get(idx, []):
            measure.insert(local_beat * beat_ql, mark)

        # Measure content: note fragments + gap rests, in beat order.
        events = sorted(pieces_by_measure.get(idx, []), key=lambda e: e[3])
        cursor = Fraction(0)
        span_dur = span.duration_beats
        for n, pidx, count, local_start, dur in events:
            if local_start > cursor:
                measure.insert(
                    cursor * beat_ql,
                    note.Rest(quarterLength=(local_start - cursor) * beat_ql),
                )
            m21_note = note.Note(quarterLength=dur * beat_ql)
            m21_note.pitch = pitch.Pitch(
                midi=horn_f.concert_to_written_midi(n.pitch_midi)
                if presentation is PitchSpace.WRITTEN_HORN_F
                else n.pitch_midi
            )
            m21_note.id = musicxml_note_id(n.id)
            n_tie = _tie_for(pidx, count, n)
            if n_tie is not None:
                m21_note.tie = n_tie
            measure.insert(local_start * beat_ql, m21_note)
            cursor = local_start + dur
        if cursor < span_dur:
            measure.insert(
                cursor * beat_ql,
                note.Rest(quarterLength=(span_dur - cursor) * beat_ql),
            )

        part.append(measure)
    return part


def build_music21_score(
    score: ScoreDocument,
    presentation: PitchSpace = PitchSpace.CONCERT,
) -> stream.Score:
    """Render *score* (canonical concert pitch) into a music21 ``Score``.

    ``presentation`` selects the export presentation: ``CONCERT`` renders
    sounding pitches verbatim; ``WRITTEN_HORN_F`` renders every part
    projected +P5 with the written key signature and Horn in F
    ``<transpose>`` metadata.
    """
    if score.pitch_space is not PitchSpace.CONCERT:
        raise NotationError("canonical ScoreDocument must be concert pitch")
    payload = score.payload
    spans = _measure_spans(payload)

    m21_score = stream.Score()
    if score.title:
        m21_score.insert(0, metadata.Metadata(title=score.title))

    for part in payload.parts:
        ordered = sorted(part.notes, key=lambda n: (n.start_beat, n.id))
        _check_monophonic(tuple(ordered))
        m21_score.append(
            _build_part_measures(payload, list(ordered), part.name, spans, presentation)
        )
    return m21_score
