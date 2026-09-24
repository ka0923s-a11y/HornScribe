"""Score-level rhythm edits on the canonical payload (#115, spec 13).

The simple note edits (pitch shift, delete/restore, enharmonic respell)
are MusicXML-level rewrites the desktop applies client-side. The three
remaining §13 edits change *timing*, so they must re-realize notation:

* ``setDuration`` — a new written duration for one canonical note;
* ``shiftOnset`` — move a note by whole minimum-grid steps;
* ``toggleTie`` — tie/untie a note to the contiguous next same-pitch
  note (a flag pair on the canonical notes; atoms are untouched).

Timing edits rebuild the smallest measure-aligned window containing
the note's old and new spans: notes inside are re-decomposed through
the same :class:`SpanRealizer` the quantizer used, gaps become rests,
and the monophonic contract is re-applied (a note may never cross the
next onset — an edit that would is rejected, not silently clipped).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from fractions import Fraction
from typing import Any

from hornscribe.domain.ids import RawNoteEventId, ScoreNoteId
from hornscribe.domain.score import (
    MeasureSpan,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    beat_ql_of,
    measure_spans,
)
from hornscribe.rhythm.contracts import NormalizedNote, RhythmAtom
from hornscribe.rhythm.meter import MeterMap, MeterSegment
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.realize import SpanRealizer
from hornscribe.rhythm.triplet import (
    TripletRegion,
    enabled_triplet_regions,
    region_evidence,
)

from .options import _PROFILES, _TRIPLET_POLICIES


class ScoreEditError(ValueError):
    """An edit that cannot be applied honestly (mapped to INVALID_PARAMS)."""


@dataclass(frozen=True)
class ScoreEdit:
    """One rhythm edit against the canonical payload.

    ``kind``: ``"setDuration"`` | ``"shiftOnset"`` | ``"toggleTie"``.
    ``noteId``: canonical ``sn-*`` id. ``durationBeats`` is the new
    written length for setDuration; ``steps`` is the signed grid-step
    count for shiftOnset (one step = min_note_value_ql).
    """

    kind: str
    note_id: ScoreNoteId
    duration_beats: Fraction | None = None
    steps: int = 0
    bpm: float | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreEdit:
        kind = data.get("kind")
        if kind not in ("setDuration", "shiftOnset", "toggleTie", "setTempo"):
            raise ScoreEditError(
                f"edit.kind must be setDuration/shiftOnset/toggleTie/setTempo, "
                f"got {kind!r}"
            )
        note_id = data.get("noteId")
        if kind == "setTempo":
            note_id = note_id if isinstance(note_id, str) else ""
        elif not isinstance(note_id, str) or not note_id:
            raise ScoreEditError("edit.noteId must be a non-empty string")
        bpm_raw = data.get("bpm")
        bpm: float | None = None
        if bpm_raw is not None:
            if isinstance(bpm_raw, bool) or not isinstance(
                bpm_raw, (int, float)
            ):
                raise ScoreEditError(
                    f"edit.bpm must be a number, got {bpm_raw!r}"
                )
            bpm = float(bpm_raw)
            if not (20.0 <= bpm <= 400.0):
                raise ScoreEditError(
                    f"edit.bpm {bpm} outside the supported 20–400 range"
                )
        if kind == "setTempo" and bpm is None:
            raise ScoreEditError("setTempo requires bpm")
        duration = data.get("durationBeats")
        try:
            duration_beats = (
                Fraction(duration) if duration is not None else None
            )
            if isinstance(duration, bool):
                raise ValueError("bool")
        except (TypeError, ValueError, ZeroDivisionError) as exc:
            raise ScoreEditError(
                f"edit.durationBeats is not a rational number: {duration!r}"
            ) from exc
        steps = data.get("steps", 0)
        if not isinstance(steps, int) or isinstance(steps, bool):
            raise ScoreEditError(f"edit.steps must be an int, got {steps!r}")
        return cls(
            kind=kind,
            note_id=ScoreNoteId(note_id),
            duration_beats=duration_beats,
            steps=steps,
            bpm=bpm,
        )


def _profile_from_settings(settings: dict[str, Any]) -> QuantizationProfile:
    """Rebuild the quantization profile the payload was produced with."""
    kind = settings.get("simplicity", "standard")
    factory = _PROFILES.get(kind, QuantizationProfile.standard)
    base = factory()
    min_dur = settings.get("minDurationQl", "1/4")
    triplets = settings.get("triplets", "auto")
    return replace(
        base,
        min_note_value_ql=Fraction(min_dur),
        triplet_policy=_TRIPLET_POLICIES.get(triplets, base.triplet_policy),
    )


def _meter_map_from_payload(payload: ScoreRevisionPayload) -> MeterMap:
    """Rebuild the meter map the payload's measure layout derives from."""
    beat_ql = beat_ql_of(payload)
    if payload.meter_changes:
        segments = tuple(
            MeterSegment(
                start_ql=c.start_beat * beat_ql,
                numerator=c.time_signature.beats_per_measure,
                denominator=c.time_signature.beat_unit,
                measure_phase_ql=c.measure_phase_beats * beat_ql,
            )
            for c in payload.meter_changes
        )
        return MeterMap(segments)
    ts = payload.time_signature
    measure_len = Fraction(ts.beats_per_measure * 4, ts.beat_unit)
    pickup_ql = payload.pickup_beats * beat_ql
    phase = (measure_len - pickup_ql) % measure_len if pickup_ql else Fraction(0)
    return MeterMap(
        (
            MeterSegment(
                start_ql=Fraction(0),
                numerator=ts.beats_per_measure,
                denominator=ts.beat_unit,
                measure_phase_ql=phase,
            ),
        )
    )


def _triplet_regions(
    notes: tuple[QuantizedNote, ...],
    meter_map: MeterMap,
    profile: QuantizationProfile,
    beat_ql: Fraction,
) -> tuple[TripletRegion, ...]:
    """Recompute the evidence-gated triplet regions for the edited notes."""
    normalized = tuple(
        NormalizedNote(
            source_id=n.source_event_ids[0]
            if n.source_event_ids
            else RawNoteEventId(str(n.id)),
            pitch_midi=n.pitch_midi,
            onset_ql=float(n.start_beat * beat_ql),
            offset_ql=float(n.end_beat * beat_ql),
        )
        for n in notes
    )
    if not normalized:
        return ()
    return enabled_triplet_regions(
        region_evidence(normalized, meter_map, profile), profile
    )


def _find_note(part: Part, note_id: ScoreNoteId) -> int:
    for i, n in enumerate(part.notes):
        if n.id == note_id:
            return i
    raise ScoreEditError(f"note {note_id} not found in the score")


def _clip_overlaps(
    notes: list[QuantizedNote], *, edited_index: int
) -> list[QuantizedNote]:
    """Re-apply the monophonic contract inside the edit window.

    An earlier note may never cross the next onset — it clips. The
    *edited* note is the exception: crossing the next onset is a user
    error (the requested span simply does not fit), so it raises rather
    than silently shortening the user's request.
    """
    out: list[QuantizedNote] = []
    for note in notes:
        if out:
            prev = out[-1]
            if prev.end_beat > note.start_beat:
                if len(out) - 1 == edited_index:
                    # The edited note may never be clipped — the user
                    # asked for a span that does not fit; say so instead
                    # of silently shortening their request.
                    raise ScoreEditError(
                        "the requested span extends past the next "
                        "note's onset"
                    )
                clipped = note.start_beat - prev.start_beat
                if clipped <= 0:
                    raise ScoreEditError(
                        f"note {prev.id} would vanish under the edit"
                    )
                out[-1] = replace(prev, duration_beats=clipped)
        out.append(note)
    # Forward check for the edited note: its end may not cross the next
    # onset (the user asked for a span that does not fit).
    idx = edited_index
    if idx + 1 < len(out) and out[idx].end_beat > out[idx + 1].start_beat:
        raise ScoreEditError(
            "the requested span extends past the next note's onset"
        )
    return out


def _tuplet_group_starts(atoms: list[RhythmAtom]) -> list[bool]:
    """Mark the first atom of each consecutive tuplet run (scorebuild)."""
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


def _atom_to_score(
    atom: RhythmAtom, beat_ql: Fraction, group_start: bool
) -> ScoreAtom:
    return ScoreAtom(
        duration_beats=atom.duration_ql / beat_ql,
        symbol=atom.symbol,
        dots=atom.dots,
        tuplet=atom.tuplet,
        tuplet_group_start=group_start,
        tie_to_next=atom.tie_to_next,
    )


def _retile_window(
    window_notes: list[QuantizedNote],
    lo: Fraction,
    hi: Fraction,
    realizer: SpanRealizer,
    beat_ql: Fraction,
) -> tuple[list[QuantizedNote], list[ScoreRest]]:
    """Re-decompose notes + rest gaps inside the edit window.

    The merged atom stream (notes + rests in onset order) gets tuplet
    group flags across the window — mirrors build_score's flow so a
    group still brackets correctly. Window bounds are measure edges,
    so tie/atom structure never crosses the splice.
    """
    events: list[tuple[Fraction, str, int]] = [
        (n.start_beat, "note", i) for i, n in enumerate(window_notes)
    ]
    gaps: list[tuple[Fraction, Fraction]] = []
    # Gaps tile the whole window — including the edges, where the
    # measure's content may not reach the barline (a shortened note
    # leaves a rest behind it).
    cursor = lo
    for n in sorted(window_notes, key=lambda n: n.start_beat):
        if n.start_beat > cursor:
            gaps.append((cursor, n.start_beat))
        cursor = max(cursor, n.end_beat)
    if cursor < hi:
        gaps.append((cursor, hi))
    events += [(g[0], "rest", i) for i, g in enumerate(gaps)]
    events.sort(key=lambda e: e[0])

    stream: list[RhythmAtom] = []
    note_ranges: list[tuple[int, int]] = [(0, 0)] * len(window_notes)
    rest_ranges: list[tuple[int, int]] = [(0, 0)] * len(gaps)
    for _pos, kind, i in events:
        if kind == "note":
            n = window_notes[i]
            notation = realizer.realize_span(
                n.start_beat * beat_ql, n.end_beat * beat_ql, is_rest=False
            ).notation
            atoms = notation.atoms if notation is not None else ()
            start = len(stream)
            stream.extend(atoms)
            note_ranges[i] = (start, len(stream))
        else:
            s, e = gaps[i]
            rest_notation = realizer.rest_span(s * beat_ql, e * beat_ql)
            atoms = rest_notation.atoms if rest_notation is not None else ()
            start = len(stream)
            stream.extend(atoms)
            rest_ranges[i] = (start, len(stream))
    flags = _tuplet_group_starts(stream)

    new_notes = [
        replace(
            n,
            atoms=tuple(
                _atom_to_score(a, beat_ql, flags[lo + j])
                for j, a in enumerate(stream[lo:hi])
            ),
        )
        for n, (lo, hi) in zip(window_notes, note_ranges, strict=True)
    ]
    new_rests = [
        ScoreRest(
            start_beat=gaps[i][0],
            atoms=tuple(
                _atom_to_score(a, beat_ql, flags[lo + j])
                for j, a in enumerate(stream[lo:hi])
            ),
        )
        for i, (lo, hi) in enumerate(rest_ranges)
        if lo < hi
    ]
    return (new_notes, new_rests)


def _expand_window(
    notes: tuple[QuantizedNote, ...],
    spans: tuple[MeasureSpan, ...],
    lo: Fraction,
    hi: Fraction,
) -> tuple[Fraction, Fraction]:
    """Grow ``[lo, hi)`` to whole measures covering every intersecting note."""
    for n in notes:
        if n.start_beat < hi and n.end_beat > lo:
            lo = min(lo, n.start_beat)
            hi = max(hi, n.end_beat)
    for span in spans:
        if span.start_beat < hi and span.end_beat > lo:
            lo = min(lo, span.start_beat)
            hi = max(hi, span.end_beat)
    return (lo, hi)


def _apply_timing_edit(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
    new_start: Fraction | None,
    new_duration: Fraction | None,
) -> Part:
    """Rebuild the part after a timing edit (setDuration/shiftOnset)."""
    part = payload.parts[part_index]
    beat_ql = beat_ql_of(payload)
    notes = list(part.notes)
    target = notes[note_index]
    start = new_start if new_start is not None else target.start_beat
    duration = (
        new_duration if new_duration is not None else target.duration_beats
    )
    if duration <= 0:
        raise ScoreEditError("duration must be positive")
    if start < 0:
        raise ScoreEditError("the note cannot start before the score")
    notes[note_index] = replace(
        target, start_beat=start, duration_beats=duration
    )
    notes.sort(key=lambda n: (n.start_beat, n.id))
    edited_index = next(i for i, n in enumerate(notes) if n.id == target.id)
    notes = _clip_overlaps(notes, edited_index=edited_index)

    # The rebuild window: every measure touching the union of old and
    # new spans, grown to cover notes straddling its edges.
    spans = measure_spans(payload)
    lo = min(target.start_beat, start)
    hi = max(target.end_beat, start + duration)
    prev = None
    while (lo, hi) != prev:
        prev = (lo, hi)
        lo, hi = _expand_window(tuple(notes), spans, lo, hi)
    window_notes = [
        n for n in notes if n.start_beat < hi and n.end_beat > lo
    ]

    profile = _profile_from_settings(payload.quantization_settings)
    meter_map = _meter_map_from_payload(payload)
    regions = _triplet_regions(tuple(notes), meter_map, profile, beat_ql)
    realizer = SpanRealizer(meter_map, profile, triplet_regions=regions)
    try:
        new_window, new_rests = _retile_window(
            window_notes, lo, hi, realizer, beat_ql
        )
    except ValueError as exc:
        raise ScoreEditError(
            f"the edited rhythm cannot be written in this meter: {exc}"
        ) from exc
    window_ids = {n.id for n in window_notes}
    final_notes = tuple(
        n if n.id not in window_ids else next(
            w for w in new_window if w.id == n.id
        )
        for n in notes
    )
    kept_rests = [
        r for r in part.rests if r.end_beat <= lo or r.start_beat >= hi
    ]
    return replace(
        part,
        notes=final_notes,
        rests=tuple(sorted(kept_rests + new_rests, key=lambda r: r.start_beat)),
    )


def _apply_tie_toggle(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
) -> Part:
    """Flip the tie between a note and the contiguous next same-pitch note."""
    part = payload.parts[part_index]
    notes = list(part.notes)
    if note_index + 1 >= len(notes):
        raise ScoreEditError("there is no next note to tie to")
    cur = notes[note_index]
    nxt = notes[note_index + 1]
    tied = cur.tie_start and nxt.tie_stop
    if tied:
        notes[note_index] = replace(cur, tie_start=False)
        notes[note_index + 1] = replace(nxt, tie_stop=False)
        return replace(part, notes=tuple(notes))
    if cur.pitch_midi != nxt.pitch_midi:
        raise ScoreEditError("a tie needs the same pitch on both notes")
    if cur.end_beat != nxt.start_beat:
        raise ScoreEditError(
            "a tie needs contiguous notes (the next note must start "
            "where this one ends)"
        )
    notes[note_index] = replace(cur, tie_start=True)
    notes[note_index + 1] = replace(nxt, tie_stop=True)
    return replace(part, notes=tuple(notes))


def _apply_set_tempo(
    payload: ScoreRevisionPayload, bpm: float
) -> ScoreRevisionPayload:
    """Set the piece's tempo (§14 BPM edit).

    The tempo segment at beat 0 is replaced (or prepended when the map
    starts later / is empty); later segments are kept — a mid-piece
    tempo change survives a head-tempo correction. This is a
    presentation-level edit: no re-tiling needed, so the whole payload
    is returned untouched apart from tempo_map.
    """
    segments = list(payload.tempo_map)
    if segments and segments[0].start_beat == 0:
        segments[0] = replace(segments[0], bpm=bpm)
    else:
        segments.insert(0, TempoSegment(start_beat=Fraction(0), bpm=bpm))
    return replace(payload, tempo_map=tuple(segments))


def apply_score_edit(
    document: ScoreDocument, edit: ScoreEdit
) -> ScoreDocument:
    """Apply one §13 rhythm edit and return the rebuilt document.

    The payload's canonical notes keep their ids — review issues and
    client-side note edits stay attached. A new score revision falls
    out of the changed content automatically (content-derived ids).
    """
    payload = document.payload
    beat_ql = beat_ql_of(payload)
    if edit.kind == "setTempo":
        if edit.bpm is None:
            raise ScoreEditError("setTempo requires bpm")
        new_payload = _apply_set_tempo(payload, edit.bpm)
        return replace(document, payload=new_payload)
    # Locate the note across parts (single-part today, but the loop is
    # free).
    part_index = -1
    note_index = -1
    for pi, part in enumerate(payload.parts):
        try:
            note_index = _find_note(part, edit.note_id)
            part_index = pi
            break
        except ScoreEditError:
            continue
    if part_index < 0:
        raise ScoreEditError(f"note {edit.note_id} not found in the score")
    part = payload.parts[part_index]
    target = part.notes[note_index]

    if edit.kind == "toggleTie":
        new_part = _apply_tie_toggle(payload, part_index, note_index)
    else:
        if edit.kind == "setDuration":
            if edit.duration_beats is None:
                raise ScoreEditError("setDuration requires durationBeats")
            new_start, new_duration = None, edit.duration_beats
        else:  # shiftOnset
            if edit.steps == 0:
                raise ScoreEditError("shiftOnset requires a non-zero steps")
            profile = _profile_from_settings(payload.quantization_settings)
            step_beats = profile.min_note_value_ql / beat_ql
            new_start = target.start_beat + step_beats * edit.steps
            new_duration = None
        new_part = _apply_timing_edit(
            payload, part_index, note_index, new_start, new_duration
        )
    parts = list(payload.parts)
    parts[part_index] = new_part
    new_payload = replace(payload, parts=tuple(parts))
    return replace(document, payload=new_payload)
