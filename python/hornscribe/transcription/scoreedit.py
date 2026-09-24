"""Score-level rhythm edits on the canonical payload (#115, spec 13).

The simple note edits (pitch shift, delete/restore, enharmonic respell)
are MusicXML-level rewrites the desktop applies client-side. The three
remaining §13 edits change *timing*, so they must re-realize notation:

* ``setDuration`` — a new written duration for one canonical note;
* ``shiftOnset`` — move a note by whole minimum-grid steps;
* ``toggleTie`` — tie/untie a note to the contiguous next same-pitch
  note (a flag pair on the canonical notes; atoms are untouched).
* ``scaleTempo`` — the tempo-octave correction (#198): scales the
  tempo map AND every beat-axis position/duration by the same factor,
  so notation values change while wall-clock playback stays put (the
  inverse of ``setTempo``, which relabels BPM only).

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

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    TranscriptionRevisionId,
    derive_transcription_revision_id,
)
from hornscribe.domain.score import (
    KeyChange,
    KeySignature,
    MeasureSpan,
    MeterChange,
    Part,
    QuantizedNote,
    ScoreAtom,
    ScoreDocument,
    ScoreRest,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
    beat_ql_of,
    measure_spans,
)
from hornscribe.rhythm.contracts import NormalizedNote, RhythmAtom
from hornscribe.rhythm.meter import MeterMap, MeterSegment
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.realize import SpanRealizer
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.rhythm.triplet import (
    TripletRegion,
    enabled_triplet_regions,
    region_evidence,
)

from .options import _PROFILES, _TRIPLET_POLICIES
from .scorebuild import _part_content


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
    beats_per_measure: int | None = None
    beat_unit: int | None = None
    settings: dict[str, Any] | None = None
    fifths: int | None = None
    mode: str | None = None
    start_beat: Fraction | None = None
    part_id: str | None = None
    pitch_midi: int | None = None
    factor: Fraction | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreEdit:
        kind = data.get("kind")
        if kind not in (
            "setDuration",
            "shiftOnset",
            "toggleTie",
            "setTempo",
            "setMeter",
            "requantize",
            "splitNote",
            "mergeNotes",
            "setKey",
            "keyChangeAt",
            "removeKeyChange",
            "restToNote",
            "scaleTempo",
        ):
            raise ScoreEditError(
                "edit.kind must be setDuration/shiftOnset/toggleTie/"
                "setTempo/setMeter/requantize/splitNote/mergeNotes/"
                "setKey/keyChangeAt/removeKeyChange/restToNote/"
                "scaleTempo, "
                f"got {kind!r}"
            )
        note_id = data.get("noteId")
        if kind in (
            "setTempo",
            "setMeter",
            "requantize",
            "setKey",
            "keyChangeAt",
            "removeKeyChange",
            "restToNote",
            "scaleTempo",
        ):
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
        beats_per_measure = _opt_int(data, "beatsPerMeasure")
        beat_unit = _opt_int(data, "beatUnit")
        if kind == "setMeter":
            if beats_per_measure is None or beat_unit is None:
                raise ScoreEditError(
                    "setMeter requires beatsPerMeasure and beatUnit"
                )
            if not (1 <= beats_per_measure <= 64):
                raise ScoreEditError(
                    f"beatsPerMeasure {beats_per_measure} outside 1-64"
                )
            if beat_unit not in (1, 2, 4, 8, 16, 32, 64):
                raise ScoreEditError(
                    f"beatUnit {beat_unit} must be a power of two (1-64)"
                )
        settings = _requantize_settings(data, kind)
        fifths = _opt_int(data, "fifths")
        mode_raw = data.get("mode")
        mode: str | None = None
        if mode_raw is not None:
            if mode_raw not in ("major", "minor"):
                raise ScoreEditError(
                    f"edit.mode must be major/minor, got {mode_raw!r}"
                )
            mode = str(mode_raw)
        if kind in ("setKey", "keyChangeAt"):
            if fifths is None:
                raise ScoreEditError(f"{kind} requires fifths")
            if not (-7 <= fifths <= 7):
                raise ScoreEditError(
                    f"edit.fifths {fifths} outside the -7..+7 range"
                )
        start_beat_raw = data.get("startBeat")
        start_beat: Fraction | None = None
        if start_beat_raw is not None:
            try:
                start_beat = Fraction(start_beat_raw)
                if isinstance(start_beat_raw, bool):
                    raise ValueError("bool")
            except (TypeError, ValueError, ZeroDivisionError) as exc:
                raise ScoreEditError(
                    f"edit.startBeat is not a rational number: "
                    f"{start_beat_raw!r}"
                ) from exc
            if start_beat < 0:
                raise ScoreEditError(
                    f"edit.startBeat must be >= 0, got {start_beat}"
                )
        if kind in ("keyChangeAt", "removeKeyChange") and start_beat is None:
            raise ScoreEditError(f"{kind} requires startBeat")
        if kind == "restToNote" and start_beat is None:
            raise ScoreEditError("restToNote requires startBeat")
        part_id_raw = data.get("partId")
        part_id: str | None = None
        if part_id_raw is not None:
            if not isinstance(part_id_raw, str) or not part_id_raw:
                raise ScoreEditError(
                    f"edit.partId must be a non-empty string, got {part_id_raw!r}"
                )
            part_id = part_id_raw
        if kind == "restToNote" and part_id is None:
            raise ScoreEditError("restToNote requires partId")
        pitch_midi = _opt_int(data, "pitchMidi")
        if kind == "restToNote":
            if pitch_midi is None:
                raise ScoreEditError("restToNote requires pitchMidi")
            if not (0 <= pitch_midi <= 127):
                raise ScoreEditError(
                    f"edit.pitchMidi {pitch_midi} outside the 0-127 range"
                )
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
        factor_raw = data.get("factor")
        factor: Fraction | None = None
        if factor_raw is not None:
            if isinstance(factor_raw, bool):
                raise ScoreEditError(
                    f"edit.factor is not a rational number: {factor_raw!r}"
                )
            try:
                # str() first: Fraction(0.1) would capture the binary
                # float, not the decimal the client sent.
                factor = Fraction(str(factor_raw))
            except (TypeError, ValueError, ZeroDivisionError) as exc:
                raise ScoreEditError(
                    f"edit.factor is not a rational number: {factor_raw!r}"
                ) from exc
        if kind == "scaleTempo":
            if factor is None:
                raise ScoreEditError("scaleTempo requires factor")
            if not (Fraction(1, 8) <= factor <= 8):
                raise ScoreEditError(
                    f"edit.factor {factor} outside the supported "
                    "1/8..8 range"
                )
        steps = data.get("steps", 0)
        if not isinstance(steps, int) or isinstance(steps, bool):
            raise ScoreEditError(f"edit.steps must be an int, got {steps!r}")
        return cls(
            kind=kind,
            note_id=ScoreNoteId(note_id),
            duration_beats=duration_beats,
            steps=steps,
            bpm=bpm,
            beats_per_measure=beats_per_measure,
            beat_unit=beat_unit,
            settings=settings,
            fifths=fifths,
            mode=mode,
            start_beat=start_beat,
            part_id=part_id,
            pitch_midi=pitch_midi,
            factor=factor,
        )


def _opt_int(data: dict[str, Any], key: str) -> int | None:
    raw = data.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ScoreEditError(f"edit.{key} must be an int, got {raw!r}")
    return raw


_REQUANTIZE_KEYS = {"minDurationQl", "triplets", "simplicity"}


def _requantize_settings(
    data: dict[str, Any], kind: str
) -> dict[str, Any] | None:
    """Validate the requantize settings overrides (#130).

    Only the quantization profile knobs are accepted — tempo and meter
    have their own edits, and unknown keys are rejected rather than
    silently ignored so a typo never looks like it applied.
    """
    raw = data.get("settings")
    if raw is None:
        if kind == "requantize":
            raise ScoreEditError("requantize requires a settings object")
        return None
    if not isinstance(raw, dict):
        raise ScoreEditError("edit.settings must be an object")
    unknown = set(raw) - _REQUANTIZE_KEYS
    if unknown:
        raise ScoreEditError(
            f"unknown requantize settings: {sorted(unknown)}"
        )
    out: dict[str, Any] = {}
    if "minDurationQl" in raw:
        try:
            value = Fraction(raw["minDurationQl"])
        except (TypeError, ValueError, ZeroDivisionError) as exc:
            raise ScoreEditError(
                "settings.minDurationQl is not a rational number: "
                f"{raw['minDurationQl']!r}"
            ) from exc
        if value <= 0:
            raise ScoreEditError("settings.minDurationQl must be > 0")
        out["minDurationQl"] = str(value)
    if "triplets" in raw:
        value = raw["triplets"]
        if value not in _TRIPLET_POLICIES:
            raise ScoreEditError(
                f"settings.triplets must be one of "
                f"{sorted(_TRIPLET_POLICIES)}, got {value!r}"
            )
        out["triplets"] = value
    if "simplicity" in raw:
        value = raw["simplicity"]
        if value not in _PROFILES:
            raise ScoreEditError(
                f"settings.simplicity must be one of "
                f"{sorted(_PROFILES)}, got {value!r}"
            )
        out["simplicity"] = value
    if kind == "requantize" and not out:
        raise ScoreEditError("requantize needs at least one setting")
    return out or None


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


def _retile_part(
    payload: ScoreRevisionPayload,
    part: Part,
    notes: list[QuantizedNote],
    lo: Fraction,
    hi: Fraction,
) -> Part:
    """Re-decompose the notes intersecting [lo, hi) and splice back.

    Shared tail of every structural edit (timing, split, merge): the
    window grows to whole measures covering straddling notes, the
    realizer rebuilds atoms + rest gaps inside it, and content outside
    the window is kept verbatim.
    """
    beat_ql = beat_ql_of(payload)
    spans = measure_spans(payload)
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


def _apply_timing_edit(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
    new_start: Fraction | None,
    new_duration: Fraction | None,
) -> Part:
    """Rebuild the part after a timing edit (setDuration/shiftOnset)."""
    part = payload.parts[part_index]
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
    lo = min(target.start_beat, start)
    hi = max(target.end_beat, start + duration)
    return _retile_part(payload, part, notes, lo, hi)


def _apply_split(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
) -> Part:
    """Split a note at its midpoint (§13 post-MVP split).

    The midpoint is snapped to the minimum grid so both halves stay
    writable; an odd-grid note (e.g. a triplet span) splits at the
    nearest grid point instead. Ties redistribute: the first half keeps
    an incoming tie, the second keeps an outgoing one, and the halves
    are never tied to each other (a split is a visible separation).
    The second half gets a fresh sn-* id continuing the document's
    numbering.
    """
    part = payload.parts[part_index]
    notes = list(part.notes)
    target = notes[note_index]
    profile = _profile_from_settings(payload.quantization_settings)
    grid = profile.min_note_value_ql
    beat_ql = beat_ql_of(payload)
    mid_ql = target.start_beat * beat_ql + target.duration_beats * beat_ql / 2
    # Snap the split point to the grid (round-half-up on the step count).
    steps = (mid_ql + grid / 2) // grid
    split_ql = steps * grid
    if not (target.start_beat * beat_ql < split_ql < target.end_beat * beat_ql):
        raise ScoreEditError(
            "the note is too short to split on the current grid"
        )
    split_beat = split_ql / beat_ql
    fresh = _next_score_note_id(payload)
    first = replace(
        target,
        duration_beats=split_beat - target.start_beat,
        tie_start=False,
        atoms=(),
    )
    second = replace(
        target,
        id=fresh,
        start_beat=split_beat,
        duration_beats=target.end_beat - split_beat,
        tie_stop=False,
        atoms=(),
    )
    notes[note_index : note_index + 1] = [first, second]
    return _retile_part(
        payload, part, notes, target.start_beat, target.end_beat
    )


def _next_score_note_id(payload: ScoreRevisionPayload) -> ScoreNoteId:
    """Fresh sn-* id continuing the document's numbering."""
    next_id = 0
    for part in payload.parts:
        for n in part.notes:
            try:
                next_id = max(next_id, int(str(n.id)[3:]) + 1)
            except ValueError:
                continue
    return ScoreNoteId(f"sn-{next_id:06d}")


def _apply_merge(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
) -> Part:
    """Merge a note with the contiguous next same-pitch note (§13 merge).

    Unlike tie-untie (which keeps two written notes), merge collapses
    the pair into ONE canonical note — the first note's id survives,
    its source_event_ids union, the second note's id is freed. The
    merged span re-tiles, so a pair split by a barline becomes a single
    tied decomposition again.
    """
    part = payload.parts[part_index]
    notes = list(part.notes)
    if note_index + 1 >= len(notes):
        raise ScoreEditError("there is no next note to merge with")
    cur = notes[note_index]
    nxt = notes[note_index + 1]
    if cur.pitch_midi != nxt.pitch_midi:
        raise ScoreEditError("a merge needs the same pitch on both notes")
    if cur.end_beat != nxt.start_beat:
        raise ScoreEditError(
            "a merge needs contiguous notes (the next note must start "
            "where this one ends)"
        )
    merged = replace(
        cur,
        duration_beats=nxt.end_beat - cur.start_beat,
        source_event_ids=cur.source_event_ids + nxt.source_event_ids,
        tie_start=nxt.tie_start,
        atoms=(),
    )
    notes[note_index : note_index + 2] = [merged]
    return _retile_part(payload, part, notes, cur.start_beat, nxt.end_beat)


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


def _apply_rest_to_note(
    payload: ScoreRevisionPayload,
    part_id: str,
    start_beat: Fraction,
    pitch_midi: int,
    duration_beats: Fraction | None,
) -> Part:
    """Convert (part of) a rest span into a new note (#163).

    start_beat must land inside a rest span of the named part; the new
    note defaults to the remainder of that span (durationBeats may
    shorten it). Positions do not shift — the leftover before/after
    the note re-tiles as rests through the shared _retile_part path,
    so measure structure, the tempo map and every other note are
    untouched. The new note gets a fresh sn-* id and empty
    source_event_ids (it has no backend evidence).
    """
    part = next((p for p in payload.parts if p.id == part_id), None)
    if part is None:
        raise ScoreEditError(f"part {part_id!r} not found in the score")
    rest = next(
        (
            r
            for r in part.rests
            if r.start_beat <= start_beat < r.end_beat
        ),
        None,
    )
    if rest is None:
        raise ScoreEditError(
            f"no rest covers beat {start_beat} in part {part_id}"
        )
    duration = duration_beats if duration_beats is not None else (
        rest.end_beat - start_beat
    )
    if duration <= 0:
        raise ScoreEditError("durationBeats must be positive")
    if start_beat + duration > rest.end_beat:
        raise ScoreEditError(
            "the new note must fit inside the rest span "
            f"({rest.start_beat}..{rest.end_beat})"
        )
    new_note = QuantizedNote(
        id=_next_score_note_id(payload),
        source_event_ids=(),
        pitch_midi=pitch_midi,
        start_beat=start_beat,
        duration_beats=duration,
    )
    notes = sorted(
        list(part.notes) + [new_note],
        key=lambda n: (n.start_beat, str(n.id)),
    )
    return _retile_part(
        payload, part, notes, rest.start_beat, rest.end_beat
    )


def _apply_set_meter(
    payload: ScoreRevisionPayload, ts: TimeSignature
) -> ScoreRevisionPayload:
    """Set the piece's meter (§14 meter edit) and re-tile every part.

    The canonical beat axis is defined by the *first* time signature's
    beat unit (beat_ql_of), so changing the unit rescales every beat
    position by new_unit / old_unit — absolute durations are preserved.
    Notes, rest spans (re-tiled anyway), the tempo map and the pickup
    all scale together; note atoms are cleared first because a scaled
    duration would violate the atoms-tile-duration invariant.

    Mid-piece meter changes are collapsed: the edit sets the whole
    piece's meter, so the resulting payload carries none (the single
    time_signature field is authoritative again). The pickup keeps its
    absolute span — a one-beat pickup stays one notated beat under the
    new signature.
    """
    old_ts = payload.time_signature
    old_beat_ql = Fraction(4, old_ts.beat_unit)
    new_beat_ql = Fraction(4, ts.beat_unit)
    # beat_ql is the quarter-length OF one beat; positions scale by the
    # inverse so beats * beat_ql (absolute QL) is preserved.
    scale = old_beat_ql / new_beat_ql  # = ts.beat_unit / old_ts.beat_unit

    profile = _profile_from_settings(payload.quantization_settings)
    pickup_ql = payload.pickup_beats * old_beat_ql
    measure_ql = Fraction(ts.beats_per_measure) * new_beat_ql
    phase_ql = (measure_ql - pickup_ql) % measure_ql if pickup_ql else Fraction(0)
    meter_map = MeterMap(
        (
            MeterSegment(
                start_ql=Fraction(0),
                numerator=ts.beats_per_measure,
                denominator=ts.beat_unit,
                measure_phase_ql=phase_ql,
            ),
        )
    )

    new_parts: list[Part] = []
    for part in payload.parts:
        scaled: list[QuantizedNote] = []
        for n in part.notes:
            if scale == 1:
                scaled.append(n)
            else:
                scaled.append(
                    replace(
                        n,
                        start_beat=n.start_beat * scale,
                        duration_beats=n.duration_beats * scale,
                        # A scaled span invalidates the committed atom
                        # decomposition — re-tiling rebuilds it below.
                        atoms=(),
                    )
                )
        # The re-tile window covers notes AND existing rest spans so a
        # trailing rest keeps its span under the new layout.
        lo = Fraction(0)
        hi = Fraction(0)
        for n in scaled:
            hi = max(hi, n.end_beat)
        for r in part.rests:
            hi = max(hi, (r.start_beat + r.duration_beats) * scale)
        regions = _triplet_regions(tuple(scaled), meter_map, profile, new_beat_ql)
        realizer = SpanRealizer(meter_map, profile, triplet_regions=regions)
        if hi > lo:
            try:
                new_notes, new_rests = _retile_window(
                    scaled, lo, hi, realizer, new_beat_ql
                )
            except ValueError as exc:
                raise ScoreEditError(
                    "the score's rhythm cannot be written in "
                    f"{ts.beats_per_measure}/{ts.beat_unit}: {exc}"
                ) from exc
            new_parts.append(
                replace(
                    part,
                    notes=tuple(new_notes),
                    rests=tuple(new_rests),
                )
            )
        else:
            new_parts.append(replace(part, notes=tuple(scaled), rests=()))

    tempo_map = tuple(
        replace(seg, start_beat=seg.start_beat * scale)
        for seg in payload.tempo_map
    )
    # The key map rides the same beat axis: rescale change positions so
    # modulations stay glued to their measure under the new beat unit.
    key_changes = tuple(
        replace(c, start_beat=c.start_beat * scale)
        for c in payload.key_changes
    )
    return replace(
        payload,
        time_signature=ts,
        pickup_beats=pickup_ql / new_beat_ql,
        meter_changes=(),
        tempo_map=tempo_map,
        key_changes=key_changes,
        parts=tuple(new_parts),
    )


def _apply_requantize(
    payload: ScoreRevisionPayload, overrides: dict[str, Any]
) -> ScoreRevisionPayload:
    """Re-quantize every part under changed quantization settings (#130).

    The canonical notes are replayed through quantize_events as synthetic
    raw events: onset/offset seconds are the note's absolute QL span and
    the warp is the identity (fixed 60 bpm), so the DP re-searches the
    grid under the merged profile — a coarser min-duration merges
    ornament notes, a finer one splits them, and triplet policy changes
    re-decide the tuplet regions.

    Canonical ids are preserved positionally: old and new note lists are
    each in score order, and index i of the new list inherits old note
    i's id (and its source_event_ids, so review evidence still resolves).
    Extra new notes get fresh ids continuing the document's numbering;
    extra old ids disappear with their notes — review issues pointing at
    a vanished id are dropped by the caller's issue filtering.
    """
    settings = {**payload.quantization_settings, **overrides}
    profile = _profile_from_settings(settings)
    meter_map = _meter_map_from_payload(payload)
    beat_ql = beat_ql_of(payload)
    warp = TimeWarp.fixed_bpm(60.0)  # identity: seconds == quarterLength
    tr_rev = TranscriptionRevisionId(
        str(
            derive_transcription_revision_id(
                {"requantize": settings, "of": str(payload.revision_id())}
            )
        )
    )

    # Highest existing sn-* index across every part — fresh ids continue
    # from here so they never collide with a surviving note.
    next_id = 0
    for part in payload.parts:
        for n in part.notes:
            try:
                next_id = max(next_id, int(str(n.id)[3:]) + 1)
            except ValueError:
                continue

    new_parts: list[Part] = []
    for part in payload.parts:
        if not part.notes:
            new_parts.append(part)
            continue
        events: list[RawNoteEvent] = []
        event_by_id: dict[RawNoteEventId, RawNoteEvent] = {}
        for i, n in enumerate(part.notes):
            event = RawNoteEvent(
                id=RawNoteEventId(f"rne-9{i:05d}"),
                transcription_revision=tr_rev,
                pitch_midi=float(n.pitch_midi),
                onset_sec=float(n.start_beat * beat_ql),
                offset_sec=float(n.end_beat * beat_ql),
                velocity=n.velocity,
                source="requantize",
            )
            events.append(event)
            event_by_id[event.id] = event
        alternatives = quantize_events(
            events,
            warp,
            meter_map,
            profile,
            alignment_shift_sec=0.0,
        )
        if not alternatives:
            raise ScoreEditError(
                "re-quantization produced no notes for this score"
            )
        notes, rests, _conf, _onsets = _part_content(
            alternatives[0], beat_ql, event_by_id
        )
        old_sorted = sorted(
            part.notes, key=lambda n: (n.start_beat, str(n.id))
        )
        remapped: list[QuantizedNote] = []
        for i, note in enumerate(notes):
            if i < len(old_sorted):
                old = old_sorted[i]
                remapped.append(
                    replace(
                        note,
                        id=old.id,
                        source_event_ids=old.source_event_ids,
                    )
                )
            else:
                remapped.append(
                    replace(note, id=ScoreNoteId(f"sn-{next_id:06d}"))
                )
                next_id += 1
        new_parts.append(
            replace(part, notes=tuple(remapped), rests=tuple(rests))
        )

    return replace(
        payload,
        parts=tuple(new_parts),
        quantization_settings=settings,
    )


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


def _scale_phase_beats(
    phase_beats: Fraction, beats_per_measure: int, factor: Fraction
) -> Fraction:
    """Rescale a meter segment's measure phase by ``factor`` (#198).

    A segment whose measures tile ``[start - p + kM, ...)`` rescales to
    ``[start*f - p' + k'M, ...)``. For factor >= 1 every old boundary
    must stay a boundary, which fixes ``p' = p*f mod M``. For factor
    < 1 the new lattice is a subset and two phases qualify; we keep the
    first in-score boundary (the one the tracker anchored), which is
    ``p' = (p - M)*f mod M`` — the same formula, since ``M*f`` is a
    whole new-measure multiple only for integer factors. A zero phase
    stays zero (the segment start is itself a boundary).
    """
    if phase_beats == 0:
        return Fraction(0)
    m = Fraction(beats_per_measure)
    return (phase_beats - m) * factor % m


def _apply_scale_tempo(
    payload: ScoreRevisionPayload, factor: Fraction
) -> ScoreRevisionPayload:
    """Scale the tempo map AND the beat axis together (#198).

    The tempo-octave fix: when the tracker picked double (or half) the
    real pulse, the tempo label AND every written note value are out by
    the same factor. ``setTempo`` only relabels the BPM — it cannot fix
    note values and would silently change playback speed. Here every
    beat-axis quantity (note/rest positions and durations, pickup,
    meter/key/tempo change boundaries) scales by ``factor`` while BPMs
    scale by ``factor`` too, so seconds stay invariant: the score is
    re-notated, not re-timed.

    Note atoms are dropped and every part re-tiles through the same
    SpanRealizer path setMeter uses — a doubled half note becomes a
    whole note (or a tied pair across the new barlines) instead of
    keeping a stale written decomposition.
    """
    beat_ql = beat_ql_of(payload)
    ts = payload.time_signature
    m0 = Fraction(ts.beats_per_measure)

    if payload.meter_changes:
        phase0 = payload.meter_changes[0].measure_phase_beats
        new_phase0 = _scale_phase_beats(phase0, ts.beats_per_measure, factor)
        new_meter_changes = tuple(
            MeterChange(
                start_beat=c.start_beat * factor,
                time_signature=c.time_signature,
                measure_phase_beats=_scale_phase_beats(
                    c.measure_phase_beats,
                    c.time_signature.beats_per_measure,
                    factor,
                ),
            )
            for c in payload.meter_changes
        )
    else:
        # Legacy single-meter layout: the phase derives from pickup.
        old_phase0 = (
            (m0 - payload.pickup_beats) % m0
            if payload.pickup_beats
            else Fraction(0)
        )
        new_phase0 = _scale_phase_beats(old_phase0, ts.beats_per_measure, factor)
        new_meter_changes = ()
    new_pickup = (m0 - new_phase0) % m0

    # The retile realizer must see the SCALED layout, so build the meter
    # map from the new boundary fields, not the old payload.
    layout = replace(
        payload,
        pickup_beats=new_pickup,
        meter_changes=new_meter_changes,
    )
    meter_map = _meter_map_from_payload(layout)
    profile = _profile_from_settings(payload.quantization_settings)

    new_parts: list[Part] = []
    for part in payload.parts:
        scaled = [
            replace(
                n,
                start_beat=n.start_beat * factor,
                duration_beats=n.duration_beats * factor,
                # A scaled span invalidates the committed atoms — the
                # retile below rebuilds the written decomposition.
                atoms=(),
            )
            for n in part.notes
        ]
        hi = Fraction(0)
        for n in scaled:
            hi = max(hi, n.end_beat)
        for r in part.rests:
            hi = max(hi, (r.start_beat + r.duration_beats) * factor)
        if hi <= 0:
            new_parts.append(replace(part, notes=tuple(scaled), rests=()))
            continue
        regions = _triplet_regions(
            tuple(scaled), meter_map, profile, beat_ql
        )
        realizer = SpanRealizer(meter_map, profile, triplet_regions=regions)
        # A bar-aligned tail under the old grid can land mid-measure
        # under the new one (factor < 1 halves the boundary count) —
        # extend the retile to the next real barline so every measure
        # still tiles exactly.
        hi_ql = hi * beat_ql
        if not realizer.is_measure_boundary(hi_ql):
            hi = realizer.next_measure_boundary(hi_ql) / beat_ql
        try:
            new_notes, new_rests = _retile_window(
                scaled, Fraction(0), hi, realizer, beat_ql
            )
        except ValueError as exc:
            raise ScoreEditError(
                "the score's rhythm cannot be written at this tempo "
                f"scale: {exc}"
            ) from exc
        new_parts.append(
            replace(part, notes=tuple(new_notes), rests=tuple(new_rests))
        )

    return replace(
        payload,
        tempo_map=tuple(
            replace(
                seg,
                start_beat=seg.start_beat * factor,
                bpm=seg.bpm * float(factor),
            )
            for seg in payload.tempo_map
        ),
        pickup_beats=new_pickup,
        meter_changes=new_meter_changes,
        key_changes=tuple(
            replace(c, start_beat=c.start_beat * factor)
            for c in payload.key_changes
        ),
        parts=tuple(new_parts),
    )


def _apply_set_key(
    payload: ScoreRevisionPayload, key: KeySignature
) -> ScoreRevisionPayload:
    """Set the piece's overall key (#145).

    The head key signature is replaced and any detected key changes are
    collapsed — 全体の調を変える means the piece now lives in the new
    key, so leftover boundaries would re-modulate into the old map.
    """
    return replace(
        payload,
        key_signature=key,
        key_changes=(
            (KeyChange(start_beat=Fraction(0), key_signature=key),)
            if payload.key_changes
            else ()
        ),
    )


def _apply_key_change_at(
    payload: ScoreRevisionPayload, key: KeySignature, start_beat: Fraction
) -> ScoreRevisionPayload:
    """Insert or update a key-change boundary (#145).

    start_beat snaps to the containing measure's start — a modulation
    mid-measure is notated at the barline (matching how the detector
    only ever emits measure-aligned changes). A change at beat 0 also
    rewrites the head key signature (the payload contract requires the
    first change to carry it).
    """
    spans = measure_spans(payload)
    snapped = spans[-1].start_beat if spans else Fraction(0)
    for span in spans:
        if span.start_beat <= start_beat < span.end_beat:
            snapped = span.start_beat
            break
    if snapped < 0:
        snapped = Fraction(0)

    changes = list(payload.key_changes)
    if not changes:
        changes = [
            KeyChange(
                start_beat=Fraction(0),
                key_signature=payload.key_signature,
            )
        ]
    head = key if snapped == 0 else changes[0].key_signature
    rest = [
        KeyChange(
            start_beat=c.start_beat,
            key_signature=key if c.start_beat == snapped else c.key_signature,
        )
        for c in changes
        if c.start_beat != 0
    ]
    if snapped != 0 and all(c.start_beat != snapped for c in rest):
        rest.append(KeyChange(start_beat=snapped, key_signature=key))
    rest.sort(key=lambda c: c.start_beat)
    if not rest:
        # Single remaining key — collapse to the legacy no-map path.
        return replace(payload, key_signature=head, key_changes=())
    return replace(
        payload,
        key_signature=head,
        key_changes=(KeyChange(Fraction(0), head), *rest),
    )


def _apply_remove_key_change(
    payload: ScoreRevisionPayload, start_beat: Fraction
) -> ScoreRevisionPayload:
    """Drop a key-change boundary (#145); the head change cannot go."""
    changes = list(payload.key_changes)
    if not changes:
        raise ScoreEditError("the score has no key changes to remove")
    if start_beat == 0:
        raise ScoreEditError(
            "the head key cannot be removed — use setKey to change it"
        )
    kept = [c for c in changes if c.start_beat != start_beat]
    if len(kept) == len(changes):
        raise ScoreEditError(f"no key change at beat {start_beat}")
    if len(kept) == 1:
        # Back to a single key — the legacy path (no keyChanges field).
        return replace(payload, key_changes=())
    return replace(payload, key_changes=tuple(kept))


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
    if edit.kind == "scaleTempo":
        if edit.factor is None:
            raise ScoreEditError("scaleTempo requires factor")
        new_payload = _apply_scale_tempo(payload, edit.factor)
        return replace(document, payload=new_payload)
    if edit.kind == "setMeter":
        if edit.beats_per_measure is None or edit.beat_unit is None:
            raise ScoreEditError(
                "setMeter requires beatsPerMeasure and beatUnit"
            )
        ts = TimeSignature(
            beats_per_measure=edit.beats_per_measure,
            beat_unit=edit.beat_unit,
        )
        new_payload = _apply_set_meter(payload, ts)
        return replace(document, payload=new_payload)
    if edit.kind == "requantize":
        if not edit.settings:
            raise ScoreEditError("requantize needs at least one setting")
        new_payload = _apply_requantize(payload, edit.settings)
        return replace(document, payload=new_payload)
    if edit.kind == "setKey":
        if edit.fifths is None:
            raise ScoreEditError("setKey requires fifths")
        key = KeySignature(
            fifths=edit.fifths, mode=edit.mode or payload.key_signature.mode
        )
        new_payload = _apply_set_key(payload, key)
        return replace(document, payload=new_payload)
    if edit.kind == "keyChangeAt":
        if edit.fifths is None or edit.start_beat is None:
            raise ScoreEditError(
                "keyChangeAt requires fifths and startBeat"
            )
        key = KeySignature(
            fifths=edit.fifths, mode=edit.mode or payload.key_signature.mode
        )
        new_payload = _apply_key_change_at(payload, key, edit.start_beat)
        return replace(document, payload=new_payload)
    if edit.kind == "removeKeyChange":
        if edit.start_beat is None:
            raise ScoreEditError("removeKeyChange requires startBeat")
        new_payload = _apply_remove_key_change(payload, edit.start_beat)
        return replace(document, payload=new_payload)
    if edit.kind == "restToNote":
        if (
            edit.part_id is None
            or edit.start_beat is None
            or edit.pitch_midi is None
        ):
            raise ScoreEditError(
                "restToNote requires partId, startBeat and pitchMidi"
            )
        new_part = _apply_rest_to_note(
            payload,
            edit.part_id,
            edit.start_beat,
            edit.pitch_midi,
            edit.duration_beats,
        )
        parts = [
            new_part if p.id == edit.part_id else p
            for p in payload.parts
        ]
        return replace(
            document,
            payload=replace(payload, parts=tuple(parts)),
        )
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
    elif edit.kind == "splitNote":
        new_part = _apply_split(payload, part_index, note_index)
    elif edit.kind == "mergeNotes":
        new_part = _apply_merge(payload, part_index, note_index)
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
