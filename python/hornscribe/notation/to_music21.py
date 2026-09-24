"""Render a canonical :class:`ScoreDocument` into a music21 stream.

HornScribe domain objects stay authoritative; this module only *renders*
them into ``music21`` objects so that music21 can carry the engraving-level
MusicXML details (dev plan §13).  Every pitched ``music21`` note is tagged
with its deterministic MusicXML export ID (:func:`musicxml_note_id`) before
serialization, so emitted ``note/@id`` values always trace back to canonical
identity.

QNT-006 architecture rule: HSQ decides musical onset/duration/rest/tie/
tuplet intent; music21 only realizes and serializes it.  When canonical
notes carry ``atoms`` (the quantizer's committed written decomposition) and
the part carries explicit ``rests``, this module places *those* atoms —
typed ``Duration`` objects built from the committed symbol/dots/tuplet —
rather than letting music21 infer note values from raw quarterLengths, and
it never invokes music21's quantizer.  Scores without atoms/rests (legacy
or provisional payloads) fall back to the previous path: barline-split
note fragments plus measure gap rests.

Responsibilities:

* measure construction from the canonical meter map (``meter_changes`` or
  the single ``time_signature`` + ``pickup_beats``), including mid-piece
  ``<time>`` attribute changes
* rendering canonical note atoms and rest atoms, honoring committed ties,
  tuplets (``<time-modification>`` + ``<tuplet>`` brackets), and the
  whole-rest-as-measure-rest convention
* splitting notes that cross barlines into tied fragments (legacy path)
* inserting rests for gaps inside measures (legacy path)
* written-pitch projection for the Horn in F presentation
  (``PitchSpace.WRITTEN_HORN_F``), including the transposed key signature
  and the ``instrument.Horn`` that produces ``<transpose>-4/-7`` metadata
* tempo map -> ``MetronomeMark`` placement

Non-responsibilities: free enharmonic respelling beyond the key-aware
default in hornscribe.notation.tone_spelling (#165) — chromatic notes the
key cannot disambiguate surface as pitch_spelling_ambiguous review
issues (#166) and the user toggles the spelling with the E key.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

from music21 import (
    chord,
    clef,
    duration,
    instrument,
    key,
    metadata,
    meter,
    note,
    pitch,
    stream,
    tempo,
    tie,
)
from music21.stream import enums as stream_enums

from hornscribe.domain.ids import ScoreNoteId, musicxml_note_id
from hornscribe.domain.score import (
    KeyChange,
    MeasureSpan,
    PitchSpace,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    beat_ql_of,
    measure_length_beats,
    measure_spans,
    note_layers,
    primary_beat_beats,
)
from hornscribe.instruments import horn_f
from hornscribe.notation.tone_spelling import fifths_at_beat, spell_name


class NotationError(ValueError):
    """Canonical content that cannot be rendered into MVP notation."""


#: Canonical atom symbol -> music21 duration type.  music21 spells
#: sixteenth-and-shorter types ordinally (``"16th"``, ``"32nd"``).
_SYMBOL_TO_M21_TYPE: dict[str, str] = {
    "whole": "whole",
    "half": "half",
    "quarter": "quarter",
    "eighth": "eighth",
    "sixteenth": "16th",
    "32nd": "32nd",
    "64th": "64th",
}

#: Canonical tuplet label -> (actual, normal) note counts for
#: ``<time-modification>``.  HSQ-v1 knows only eighth/quarter triplets.
_TUPLET_RATIOS: dict[str, tuple[int, int]] = {"triplet": (3, 2)}


def _content_end_beat(payload: ScoreRevisionPayload) -> Fraction:
    end = payload.pickup_beats
    for part in payload.parts:
        for n in part.notes:
            end = max(end, n.start_beat + n.duration_beats)
        for r in part.rests:
            end = max(end, r.end_beat)
    return end


def _tie_for(piece_index: int, piece_count: int, note_: QuantizedNote) -> tie.Tie | None:
    """Tie for one emitted fragment of a canonical note (legacy path).

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


def _atom_tie(
    atom: ScoreAtom, is_first: bool, is_last: bool, note_: QuantizedNote
) -> tie.Tie | None:
    """Tie for one committed atom of a canonical note.

    Interior atom boundaries come from ``tie_to_next``; the canonical
    ``tie_stop``/``tie_start`` flags attach to the first/last atom.
    """
    tie_in = not is_first or note_.tie_stop
    tie_out = atom.tie_to_next or (is_last and note_.tie_start)
    if tie_in and tie_out:
        return tie.Tie("continue")
    if tie_in:
        return tie.Tie("stop")
    if tie_out:
        return tie.Tie("start")
    return None


def _typed_duration(atom: ScoreAtom, beat_ql: Fraction) -> duration.Duration:
    """Build a music21 ``Duration`` from a committed atom.

    The atom's ``symbol``/``dots``/``tuplet`` fully determine the quarter
    length — constructing the Duration from them (instead of assigning a
    quarterLength, which makes music21 re-derive the type) is what keeps
    the notation layer from re-quantizing HSQ's decisions.  The derived
    quarterLength is verified against the atom's exact span; a mismatch
    means the atom is not writable as a single symbol.
    """
    type_str = _SYMBOL_TO_M21_TYPE.get(atom.symbol)
    if type_str is None:
        raise NotationError(f"unwritable atom symbol: {atom.symbol!r}")
    d = duration.Duration(type=type_str, dots=atom.dots)
    if atom.tuplet is not None:
        ratio = _TUPLET_RATIOS.get(atom.tuplet)
        if ratio is None:
            raise NotationError(f"unsupported tuplet label: {atom.tuplet!r}")
        d.appendTuplet(duration.Tuplet(*ratio))
    expected_ql = atom.duration_beats * beat_ql
    if d.quarterLength != expected_ql:
        raise NotationError(
            f"atom {atom.symbol}+{atom.dots}dot tuplet={atom.tuplet} realizes "
            f"{d.quarterLength} ql but commits {expected_ql} ql"
        )
    return d


@dataclass(frozen=True)
class _Entry:
    """One committed element placed inside a measure."""

    kind: str  # "note" | "rest" | "legacy-note" (note without atoms)
    local_start_beats: Fraction
    dur_beats: Fraction
    note_: QuantizedNote | None = None
    atom: ScoreAtom | None = None
    atom_index: int = 0
    piece_index: int = 0
    piece_count: int = 1
    # #155: notation layer (voice) this entry belongs to. 0 = primary;
    # chord members share their root's layer.
    layer: int = 0

    @property
    def local_end_beats(self) -> Fraction:
        return self.local_start_beats + self.dur_beats


def _note_pieces(
    note_: QuantizedNote, spans: tuple[MeasureSpan, ...]
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


def _atom_measure_index(
    atom_start: Fraction, atom_end: Fraction, spans: tuple[MeasureSpan, ...], owner: str
) -> int:
    """Index of the measure containing a committed atom (barline check).

    Canonical atoms never cross a barline — if one does, the atom list is
    inconsistent and rendering must fail loudly rather than let music21
    silently re-split it.
    """
    for idx, span in enumerate(spans):
        if span.start_beat <= atom_start < span.end_beat:
            if atom_end > span.end_beat:
                raise NotationError(
                    f"{owner} atom [{atom_start}, {atom_end}) crosses the "
                    f"barline at {span.end_beat}"
                )
            return idx
    raise NotationError(f"{owner} atom at {atom_start} falls outside all measures")


def _measure_entries(
    part_notes: list[QuantizedNote],
    part_rests: tuple[ScoreRest, ...],
    spans: tuple[MeasureSpan, ...],
    layer_by_id: dict[ScoreNoteId, int] | None = None,
) -> dict[int, list[_Entry]]:
    """Distribute committed atoms / legacy note pieces into measures."""
    layers = layer_by_id or {}
    entries: dict[int, list[_Entry]] = {}
    for n in part_notes:
        layer = layers.get(n.id, 0)
        if n.atoms:
            pos = n.start_beat
            for i, atom in enumerate(n.atoms):
                sidx = _atom_measure_index(
                    pos, pos + atom.duration_beats, spans, f"note {n.id}"
                )
                entries.setdefault(sidx, []).append(
                    _Entry(
                        kind="note",
                        local_start_beats=pos - spans[sidx].start_beat,
                        dur_beats=atom.duration_beats,
                        note_=n,
                        atom=atom,
                        atom_index=i,
                        layer=layer,
                    )
                )
                pos += atom.duration_beats
        else:
            pieces = _note_pieces(n, spans)
            for pidx, (sidx, local_start, dur) in enumerate(pieces):
                entries.setdefault(sidx, []).append(
                    _Entry(
                        kind="legacy-note",
                        local_start_beats=local_start,
                        dur_beats=dur,
                        note_=n,
                        piece_index=pidx,
                        piece_count=len(pieces),
                        layer=layer,
                    )
                )
    for r in part_rests:
        pos = r.start_beat
        for atom in r.atoms:
            sidx = _atom_measure_index(
                pos, pos + atom.duration_beats, spans, f"rest at {r.start_beat}"
            )
            entries.setdefault(sidx, []).append(
                _Entry(
                    kind="rest",
                    local_start_beats=pos - spans[sidx].start_beat,
                    dur_beats=atom.duration_beats,
                    atom=atom,
                )
            )
            pos += atom.duration_beats
    return entries


def _pitch_midi(note_: QuantizedNote, presentation: PitchSpace) -> int:
    return (
        horn_f.concert_to_written_midi(note_.pitch_midi)
        if presentation is PitchSpace.WRITTEN_HORN_F
        else note_.pitch_midi
    )


def _make_rest(atom: ScoreAtom, beat_ql: Fraction) -> note.Rest:
    """Rest element for one committed rest atom.

    A ``whole`` rest atom that fills a measure whose written length differs
    from a whole note (6/8, 2/4, clipped measures) is the *measure-rest
    convention*: music21 emits ``<rest measure="yes"/>`` for a rest that
    fills its measure, so it is built from the exact quarterLength rather
    than the ``whole`` type.
    """
    try:
        d = _typed_duration(atom, beat_ql)
    except NotationError:
        if atom.symbol != "whole" or atom.tuplet is not None:
            raise
        return note.Rest(quarterLength=atom.duration_beats * beat_ql)
    rest = note.Rest()
    rest.duration = d
    return rest


def _chord_key(entry: _Entry) -> tuple[Fraction, Fraction, tuple[ScoreAtom, ...]] | None:
    """Chord-membership key for a note entry (#155).

    Notes sharing (start, duration, atoms) are chord members — their
    per-atom entries merge into one ``chord.Chord``.  Rests and entries
    without a note return ``None``.
    """
    if entry.note_ is None:
        return None
    n = entry.note_
    return (n.start_beat, n.duration_beats, n.atoms)


def _render_entries(
    measure: stream.Measure,
    span: MeasureSpan,
    entries: list[_Entry],
    beat_ql: Fraction,
    strict: bool,
    presentation: PitchSpace,
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
) -> None:
    """Insert a measure's elements, grouped into notation layers (#155).

    Layer 0 renders directly into the measure (the historical single-
    voice path); higher layers render inside ``stream.Voice`` objects so
    music21 emits ``<backup>``/``<voice>`` structure.  Entries sharing a
    chord key merge into ``chord.Chord`` members.
    """
    by_layer: dict[int, list[_Entry]] = {}
    for e in entries:
        by_layer.setdefault(e.layer, []).append(e)
    if not by_layer:
        return
    targets: dict[int, stream.Voice | stream.Measure] = {}
    for layer in sorted(by_layer):
        if layer == 0 and len(by_layer) == 1:
            targets[layer] = measure
        else:
            v = stream.Voice()
            v.id = layer + 1
            measure.insert(0, v)
            targets[layer] = v
    for layer in sorted(by_layer):
        _render_layer(
            targets[layer],
            span,
            by_layer[layer],
            beat_ql,
            strict and layer == 0,
            presentation,
            head_fifths,
            key_changes,
            hide_gap_rests=layer > 0,
        )


def _render_layer(
    target: stream.Voice | stream.Measure,
    span: MeasureSpan,
    entries: list[_Entry],
    beat_ql: Fraction,
    strict: bool,
    presentation: PitchSpace,
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    hide_gap_rests: bool,
) -> None:
    """Insert one layer's elements (committed atoms or legacy fragments).

    ``strict`` mode (the part carries canonical rests) requires the entries
    to tile the measure exactly — every atom the quantizer committed is
    rendered, nothing is invented.  Non-strict layers fill gaps with
    ``quarterLength`` rests; ``hide_gap_rests`` marks secondary-voice
    fillers ``print-object=no`` so the verification pass can tell them
    apart from canonical rests.
    """
    entries.sort(key=lambda e: e.local_start_beats)

    if strict:
        cursor = Fraction(0)
        i = 0
        while i < len(entries):
            group = [entries[i]]
            i += 1
            while i < len(entries) and entries[i].local_start_beats == group[0].local_start_beats:
                group.append(entries[i])
                i += 1
            if group[0].local_start_beats != cursor:
                raise NotationError(
                    f"canonical rests do not tile measure {span.number}: "
                    f"gap/overlap at beat {cursor} (next element at "
                    f"{group[0].local_start_beats})"
                )
            cursor = max(e.local_end_beats for e in group)
        if cursor != span.duration_beats:
            raise NotationError(
                f"canonical rests do not tile measure {span.number}: "
                f"elements end at {cursor}, measure ends at "
                f"{span.duration_beats}"
            )

    def gap_rest(start: Fraction, end: Fraction) -> note.Rest:
        rest = note.Rest(quarterLength=(end - start) * beat_ql)
        if hide_gap_rests:
            rest.style.hideObjectOnPrint = True
        return rest

    placed: list[tuple[_Entry, note.GeneralNote]] = []
    cursor = Fraction(0)
    i = 0
    while i < len(entries):
        e = entries[i]
        if not strict and e.local_start_beats > cursor:
            target.insert(cursor * beat_ql, gap_rest(cursor, e.local_start_beats))
        if e.kind == "rest":
            assert e.atom is not None
            element: note.GeneralNote = _make_rest(e.atom, beat_ql)
            target.insert(e.local_start_beats * beat_ql, element)
            placed.append((e, element))
            cursor = e.local_end_beats
            i += 1
            continue
        # #155: gather every member of the chord group at this position
        # — entries sharing the chord key AND atom index merge into one
        # chord.Chord so each member keeps its canonical export id.
        members = [e]
        i += 1
        key_ = _chord_key(e)
        while (
            i < len(entries)
            and entries[i].local_start_beats == e.local_start_beats
            and entries[i].kind != "rest"
            and entries[i].atom_index == e.atom_index
            and _chord_key(entries[i]) == key_
            and key_ is not None
        ):
            members.append(entries[i])
            i += 1
        m21_notes: list[note.Note] = []
        for m in members:
            assert m.note_ is not None
            m21_note = note.Note()
            if m.atom is not None:
                m21_note.duration = _typed_duration(m.atom, beat_ql)
            else:
                m21_note.duration = duration.Duration(
                    quarterLength=m.dur_beats * beat_ql
                )
            # #165: spell against the key active at this note's onset.
            # Concert pitch spells against the concert key; the written
            # horn view spells against the written key (concert +1 fifth).
            fifths = fifths_at_beat(
                head_fifths, key_changes, m.note_.start_beat
            )
            if presentation is PitchSpace.WRITTEN_HORN_F:
                fifths += 1
            m21_note.pitch = pitch.Pitch(
                spell_name(_pitch_midi(m.note_, presentation), fifths)
            )
            m21_note.id = musicxml_note_id(m.note_.id)
            if m.atom is not None:
                is_last = m.atom_index == len(m.note_.atoms) - 1
                n_tie = _atom_tie(m.atom, m.atom_index == 0, is_last, m.note_)
            else:
                n_tie = _tie_for(m.piece_index, m.piece_count, m.note_)
            if n_tie is not None:
                m21_note.tie = n_tie
            m21_notes.append(m21_note)
        if len(m21_notes) == 1:
            element = m21_notes[0]
        else:
            element = chord.Chord(m21_notes)
            element.id = m21_notes[0].id
        target.insert(e.local_start_beats * beat_ql, element)
        placed.append((members[0], element))
        cursor = max(x.local_end_beats for x in members)

    if not strict and cursor < span.duration_beats:
        target.insert(
            cursor * beat_ql,
            gap_rest(cursor, span.duration_beats),
        )

    _mark_tuplet_groups(placed)


def _mark_tuplet_groups(placed: list[tuple[_Entry, note.GeneralNote]]) -> None:
    """Set ``<tuplet>`` start/stop types on each committed tuplet group.

    Groups are delimited by ``atom.tuplet_group_start`` (committed by the
    quantizer bridge) and never span measures or note/rest boundaries, so
    one pass over this measure's elements suffices.
    """
    open_group: list[note.GeneralNote] = []

    def close() -> None:
        if not open_group:
            return
        if len(open_group) == 1:
            _set_tuplet_type(open_group[0], "startStop")
        else:
            _set_tuplet_type(open_group[-1], "stop")
        open_group.clear()

    for entry, element in placed:
        atom = entry.atom
        if atom is not None and atom.tuplet is not None:
            if atom.tuplet_group_start or not open_group:
                close()
                _set_tuplet_type(element, "start")
            open_group.append(element)
        else:
            close()
    close()


def _set_tuplet_type(
    element: note.GeneralNote, type_: Literal["start", "stop", "startStop"]
) -> None:
    tuplets = element.duration.tuplets
    if not tuplets:
        raise NotationError("tuplet group marker on an element without a tuplet")
    tuplets[0].type = type_


def _build_part_measures(
    payload: ScoreRevisionPayload,
    part_notes: list[QuantizedNote],
    part_rests: tuple[ScoreRest, ...],
    part_name: str,
    spans: tuple[MeasureSpan, ...],
    presentation: PitchSpace,
) -> stream.Part:
    beat_ql = beat_ql_of(payload)
    strict = bool(part_rests)
    part = stream.Part()
    part.partName = part_name
    if presentation is PitchSpace.WRITTEN_HORN_F:
        part.insert(0, instrument.Horn())

    tempo_marks: dict[int, list[tuple[Fraction, tempo.MetronomeMark]]] = {}
    for seg in payload.tempo_map:
        for idx, span in enumerate(spans):
            if span.start_beat <= seg.start_beat < span.end_beat:
                # #157: tempo_map bpm counts *primary* beats of the
                # meter active at the mark (6/8 -> dotted quarter).
                # Without the referent music21 prints quarter=bpm and
                # Verovio plays compound meters 1.5x too slow.
                mark = tempo.MetronomeMark(
                    number=seg.bpm,
                    referent=duration.Duration(
                        float(
                            primary_beat_beats(span.time_signature, beat_ql)
                            * beat_ql
                        )
                    ),
                )
                tempo_marks.setdefault(idx, []).append((seg.start_beat - span.start_beat, mark))
                break
        else:
            # Segment begins at/after the content end: keep the tempo
            # change by anchoring it to the end of the final measure.
            mark = tempo.MetronomeMark(
                number=seg.bpm,
                referent=duration.Duration(
                    float(
                        primary_beat_beats(
                            spans[-1].time_signature, beat_ql
                        )
                        * beat_ql
                    )
                ),
            )
            tempo_marks.setdefault(len(spans) - 1, []).append(
                (spans[-1].duration_beats, mark)
            )

    # #133 key map: each KeyChange becomes a KeySignature at its offset
    # inside the containing measure (mid-measure modulations land on the
    # beat they start at). With no key_changes the head signature is
    # emitted on the first measure as before.
    key_marks: dict[int, list[tuple[Fraction, key.KeySignature]]] = {}
    if payload.key_changes:
        for change in payload.key_changes:
            ks = change.key_signature
            if presentation is PitchSpace.WRITTEN_HORN_F:
                ks = horn_f.written_key_signature(ks)
            ks_mark = key.KeySignature(ks.fifths)
            for idx, span in enumerate(spans):
                if span.start_beat <= change.start_beat < span.end_beat:
                    key_marks.setdefault(idx, []).append(
                        (change.start_beat - span.start_beat, ks_mark)
                    )
                    break
            else:
                key_marks.setdefault(len(spans) - 1, []).append(
                    (spans[-1].duration_beats, ks_mark)
                )

    # #155: notes sharing (start, duration, atoms) are chord members on
    # one layer; other overlaps get their own layer (voice).
    entries_by_measure = _measure_entries(
        part_notes, part_rests, spans, note_layers(tuple(part_notes))
    )

    for idx, span in enumerate(spans):
        measure = stream.Measure(number=span.number)
        if span.implicit:
            # music21 maps MusicXML implicit="yes" to showNumber=NEVER.
            measure.showNumber = stream_enums.ShowNumber.NEVER

        if idx == 0 and not key_marks.get(0):
            ks = payload.key_signature
            if presentation is PitchSpace.WRITTEN_HORN_F:
                ks = horn_f.written_key_signature(ks)
            measure.insert(0, key.KeySignature(ks.fifths))
        if idx == 0:
            ts = span.time_signature
            measure.insert(0, meter.TimeSignature(f"{ts.beats_per_measure}/{ts.beat_unit}"))
            measure.insert(0, clef.TrebleClef())
        elif span.meter_change:
            ts = span.time_signature
            measure.insert(
                0, meter.TimeSignature(f"{ts.beats_per_measure}/{ts.beat_unit}")
            )

        for local_beat, ks_mark in key_marks.get(idx, []):
            measure.insert(local_beat * beat_ql, ks_mark)

        for local_beat, mark in tempo_marks.get(idx, []):
            measure.insert(local_beat * beat_ql, mark)

        _render_entries(
            measure,
            span,
            entries_by_measure.get(idx, []),
            beat_ql,
            strict,
            presentation,
            payload.key_signature.fifths,
            payload.key_changes,
        )

        # Declared partial measures (anacrusis, meter-change clips, a short
        # final bar) must not be silently padded by music21 with hidden
        # rests — the deficit is metrical, not content.  paddingLeft covers
        # the portion of the measure cycle before the span (pickup/phased
        # segment starts), paddingRight the portion after it.
        measure_len_ql = measure_length_beats(span.time_signature, beat_ql) * beat_ql
        pad_left = span.cycle_offset_beats * beat_ql
        pad_right = measure_len_ql - pad_left - span.duration_beats * beat_ql
        if pad_left > 0:
            measure.paddingLeft = pad_left
        if pad_right > 0:
            measure.paddingRight = pad_right

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
    spans = measure_spans(payload)

    m21_score = stream.Score()
    if score.title:
        m21_score.insert(0, metadata.Metadata(title=score.title))

    for part in payload.parts:
        ordered = sorted(part.notes, key=lambda n: (n.start_beat, n.pitch_midi, n.id))
        m21_score.append(
            _build_part_measures(
                payload, list(ordered), part.rests, part.name, spans, presentation
            )
        )
    return m21_score
