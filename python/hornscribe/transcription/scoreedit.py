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
from itertools import pairwise
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
    note_layers,
)
from hornscribe.rhythm.beatmap import BeatAnchor, BeatSource
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
    # #145: keyChangeAt/removeKeyChange may name a measure number
    # instead of a raw beat — the UI knows measures, not beats.
    start_measure: int | None = None
    part_id: str | None = None
    pitch_midi: int | None = None
    factor: Fraction | None = None
    alternative_notes: tuple[dict[str, Any], ...] | None = None
    # #271: setMetadata — {title?, composer?, arranger?}; present
    # keys are applied verbatim ("" clears), absent keys keep.
    metadata: dict[str, Any] | None = None
    # #267/#261: transposeNote/transposeRange — signed semitones
    # (±12 for the octave actions).
    semitones: int | None = None
    # #267: transposeRange's optional upper bound (startBeat is the
    # lower bound, both exclusive of rests).
    end_beat: Fraction | None = None

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
            "tempoChangeAt",
            "removeTempoChange",
            "restToNote",
            "scaleTempo",
            "applyAlternative",
            "applyTriplet",
            "setMetadata",
            "transposeNote",
            "transposeRange",
        ):
            raise ScoreEditError(
                "edit.kind must be setDuration/shiftOnset/toggleTie/"
                "setTempo/setMeter/requantize/splitNote/mergeNotes/"
                "setKey/keyChangeAt/removeKeyChange/restToNote/"
                "tempoChangeAt/removeTempoChange/"
                "scaleTempo/applyAlternative/applyTriplet/setMetadata/"
                "transposeNote/transposeRange, "
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
            "tempoChangeAt",
            "removeTempoChange",
            "restToNote",
            "scaleTempo",
            "applyAlternative",
            "applyTriplet",
            "setMetadata",
            "transposeRange",
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
        if kind == "tempoChangeAt" and bpm is None:
            raise ScoreEditError("tempoChangeAt requires bpm")
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
        end_beat_raw = data.get("endBeat")
        end_beat: Fraction | None = None
        if end_beat_raw is not None:
            try:
                end_beat = Fraction(end_beat_raw)
                if isinstance(end_beat_raw, bool):
                    raise ValueError("bool")
            except (TypeError, ValueError, ZeroDivisionError) as exc:
                raise ScoreEditError(
                    f"edit.endBeat is not a rational number: "
                    f"{end_beat_raw!r}"
                ) from exc
            if end_beat < 0:
                raise ScoreEditError(
                    f"edit.endBeat must be >= 0, got {end_beat}"
                )
        start_measure_raw = data.get("startMeasure")
        start_measure: int | None = None
        if start_measure_raw is not None:
            if (
                isinstance(start_measure_raw, bool)
                or not isinstance(start_measure_raw, int)
                or start_measure_raw < 0
            ):
                raise ScoreEditError(
                    "edit.startMeasure must be an integer >= 0, "
                    f"got {start_measure_raw!r}"
                )
            start_measure = start_measure_raw
        if start_beat is not None and start_measure is not None:
            raise ScoreEditError(
                "edit takes startBeat or startMeasure, not both"
            )
        if (
            kind in (
                "keyChangeAt",
                "removeKeyChange",
                "tempoChangeAt",
                "removeTempoChange",
            )
            and start_beat is None
            and start_measure is None
        ):
            raise ScoreEditError(
                f"{kind} requires startBeat or startMeasure"
            )
        if kind == "applyTriplet" and start_beat is None:
            raise ScoreEditError("applyTriplet requires startBeat")
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
        alternative_notes = _alternative_notes(data, kind)
        steps = data.get("steps", 0)
        if not isinstance(steps, int) or isinstance(steps, bool):
            raise ScoreEditError(f"edit.steps must be an int, got {steps!r}")
        metadata: dict[str, Any] | None = None
        metadata_raw = data.get("metadata")
        if metadata_raw is not None:
            if not isinstance(metadata_raw, dict):
                raise ScoreEditError(
                    f"edit.metadata must be an object, got {metadata_raw!r}"
                )
            unknown = set(metadata_raw) - {"title", "composer", "arranger"}
            if unknown:
                raise ScoreEditError(
                    f"edit.metadata has unknown keys: {sorted(unknown)}"
                )
            for key, value in metadata_raw.items():
                if value is not None and not isinstance(value, str):
                    raise ScoreEditError(
                        f"edit.metadata.{key} must be a string, "
                        f"got {value!r}"
                    )
            metadata = dict(metadata_raw)
        if kind == "setMetadata" and not metadata:
            raise ScoreEditError("setMetadata requires metadata")
        semitones_raw = data.get("semitones")
        semitones: int | None = None
        if semitones_raw is not None:
            if (
                isinstance(semitones_raw, bool)
                or not isinstance(semitones_raw, int)
            ):
                raise ScoreEditError(
                    f"edit.semitones must be an int, got {semitones_raw!r}"
                )
            if not (-48 <= semitones_raw <= 48) or semitones_raw == 0:
                raise ScoreEditError(
                    f"edit.semitones {semitones_raw} outside the "
                    "nonzero -48..+48 range"
                )
            semitones = semitones_raw
        if kind in ("transposeNote", "transposeRange") and semitones is None:
            raise ScoreEditError(f"{kind} requires semitones")
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
            start_measure=start_measure,
            end_beat=end_beat,
            part_id=part_id,
            pitch_midi=pitch_midi,
            factor=factor,
            alternative_notes=alternative_notes,
            metadata=metadata,
            semitones=semitones,
        )


def _alternative_notes(
    data: dict[str, Any], kind: str
) -> tuple[dict[str, Any], ...] | None:
    """Validate the applyAlternative note spans (#208).

    Each entry is ``{id, startBeat, durationBeats}`` — the runner-up
    interpretation the ambiguous-quantization issue embeds in its
    evidence. Ids must be non-empty strings; spans must be rational
    with duration > 0.
    """
    raw = data.get("notes")
    if raw is None:
        if kind == "applyAlternative":
            raise ScoreEditError("applyAlternative requires notes")
        return None
    if not isinstance(raw, list):
        raise ScoreEditError("edit.notes must be an array")
    out: list[dict[str, Any]] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ScoreEditError(f"edit.notes[{i}] must be an object")
        nid = entry.get("id")
        if not isinstance(nid, str) or not nid:
            raise ScoreEditError(
                f"edit.notes[{i}].id must be a non-empty string"
            )
        try:
            start = Fraction(str(entry.get("startBeat")))
            dur = Fraction(str(entry.get("durationBeats")))
        except (TypeError, ValueError, ZeroDivisionError) as exc:
            raise ScoreEditError(
                f"edit.notes[{i}] has non-rational beats: {entry!r}"
            ) from exc
        if start < 0 or dur <= 0:
            raise ScoreEditError(
                f"edit.notes[{i}] needs startBeat >= 0 and "
                "durationBeats > 0"
            )
        out.append({"id": nid, "start": start, "duration": dur})
    if kind == "applyAlternative" and not out:
        raise ScoreEditError("applyAlternative needs at least one note")
    return tuple(out) or None


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


def _next_in_layer(
    part: Part,
    note_index: int,
) -> int | None:
    """Index of the next note in the selected note's notation layer (#260).

    Merge/tie are temporal operations on one voice: the partner is the
    first note of the NEXT onset group on the same layer — never a
    chord mate (same onset, same layer) and never a note on another
    layer. Raw ``notes[i + 1]`` adjacency breaks the moment a chord
    member or secondary voice sits between the two notes.
    """
    notes = part.notes
    sel = notes[note_index]
    layers = note_layers(notes)
    sel_layer = layers.get(sel.id, 0)
    # Earliest onset strictly after the selection's onset, on the same
    # layer. Chord mates share sel.start_beat and are excluded by the
    # strict comparison.
    next_start = min(
        (
            n.start_beat
            for n in notes
            if n.id != sel.id
            and layers.get(n.id, 0) == sel_layer
            and n.start_beat > sel.start_beat
        ),
        default=None,
    )
    if next_start is None:
        return None
    for i, n in enumerate(notes):
        if (
            n.start_beat == next_start
            and layers.get(n.id, 0) == sel_layer
            and n.pitch_midi == sel.pitch_midi
        ):
            return i
    # The next onset group on this layer has no same-pitch note — the
    # caller reports the usual same-pitch error (we never skip ahead
    # to a later onset; that would jump over intervening material).
    for i, n in enumerate(notes):
        if n.start_beat == next_start and layers.get(n.id, 0) == sel_layer:
            return i
    return None


def _clip_overlaps(
    notes: list[QuantizedNote],
    *,
    edited_index: int,
    original: tuple[QuantizedNote, ...] | None = None,
) -> list[QuantizedNote]:
    """Re-apply the per-layer monophonic contract inside the edit window.

    Within one notation layer an earlier note may never cross the next
    onset — it clips.  Chord members and secondary layers (#155) are
    exempt: simultaneous or layered notes are legitimate content, not
    collisions.  ``original`` is the PRE-EDIT note tuple — layer
    membership and the same-onset exemption are judged against it, so
    an edit that moves a note cannot silently relayer it or fabricate
    a chord out of a collision (the edited note crossing the next onset
    in its own layer is a user error — the requested span simply does
    not fit).
    """
    basis = original if original is not None else tuple(notes)
    layers = note_layers(basis)
    pre_starts = {n.id: n.start_beat for n in basis}

    def unmoved_pair(a: QuantizedNote, b: QuantizedNote) -> bool:
        """Same-onset pair that already existed before the edit."""
        return (
            a.start_beat == b.start_beat
            and pre_starts.get(a.id) == a.start_beat
            and pre_starts.get(b.id) == b.start_beat
        )

    edited_layer = layers.get(notes[edited_index].id, 0)
    out: list[QuantizedNote] = []
    for note in notes:
        note_layer = layers.get(note.id, 0)
        if out:
            # Find the previous note on THIS layer — overlaps across
            # layers are the point of layered notation.
            prev_idx = next(
                (
                    j
                    for j in range(len(out) - 1, -1, -1)
                    if layers.get(out[j].id, 0) == note_layer
                ),
                None,
            )
            if prev_idx is not None:
                prev = out[prev_idx]
                if prev.end_beat > note.start_beat and not unmoved_pair(prev, note):
                    if prev_idx == edited_index:
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
                    out[prev_idx] = replace(prev, duration_beats=clipped)
        out.append(note)
    # Forward check for the edited note: its end may not cross the next
    # onset in its own layer.
    idx = edited_index
    for nxt in out[idx + 1 :]:
        if layers.get(nxt.id, 0) != edited_layer:
            continue
        if unmoved_pair(out[idx], nxt):
            continue  # chord sibling — shared onset is legitimate
        if out[idx].end_beat > nxt.start_beat:
            raise ScoreEditError(
                "the requested span extends past the next note's onset"
            )
        break
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
    extra_regions: tuple[TripletRegion, ...] = (),
) -> Part:
    """Re-decompose the notes intersecting [lo, hi) and splice back.

    Shared tail of every structural edit (timing, split, merge): the
    window grows to whole measures covering straddling notes, the
    realizer rebuilds atoms + rest gaps inside it, and content outside
    the window is kept verbatim.

    ``extra_regions`` (#212) force-enables triplet positions inside the
    given beats for this retile only — applyTriplet's remedy for a
    possible_triplet issue.
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
    if extra_regions:
        seen = {r.start_ql for r in regions}
        regions = tuple(
            sorted(
                (*regions, *(r for r in extra_regions if r.start_ql not in seen)),
                key=lambda r: r.start_ql,
            )
        )
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
    # #155: layer membership and the chord exemption are judged against
    # the PRE-EDIT layout — otherwise lengthening a note would relayer
    # it and the fit-check would never fire.
    pre_edit = tuple(notes)
    notes[note_index] = replace(
        target, start_beat=start, duration_beats=duration
    )
    notes.sort(key=lambda n: (n.start_beat, n.id))
    edited_index = next(i for i, n in enumerate(notes) if n.id == target.id)
    notes = _clip_overlaps(
        notes, edited_index=edited_index, original=pre_edit
    )

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
    cur = notes[note_index]
    next_index = _next_in_layer(part, note_index)
    if next_index is None:
        raise ScoreEditError("there is no next note to merge with")
    nxt = notes[next_index]
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
        # #224: a merge with a live note revives the span — the result
        # stays deleted only when BOTH inputs were deleted.
        deleted=cur.deleted and nxt.deleted,
    )
    # The layer partner is not necessarily adjacent in storage order —
    # remove it by index first (it always sits after cur in time, but
    # not necessarily after cur in the array).
    del notes[next_index]
    if next_index < note_index:
        note_index -= 1
    notes[note_index] = merged
    return _retile_part(payload, part, notes, cur.start_beat, nxt.end_beat)


def _apply_tie_toggle(
    payload: ScoreRevisionPayload,
    part_index: int,
    note_index: int,
) -> Part:
    """Flip the tie between a note and the contiguous next same-pitch note."""
    part = payload.parts[part_index]
    notes = list(part.notes)
    cur = notes[note_index]
    next_index = _next_in_layer(part, note_index)
    if next_index is None:
        raise ScoreEditError("there is no next note to tie to")
    nxt = notes[next_index]
    tied = cur.tie_start and nxt.tie_stop
    if tied:
        notes[note_index] = replace(cur, tie_start=False)
        notes[next_index] = replace(nxt, tie_stop=False)
        return replace(part, notes=tuple(notes))
    if cur.pitch_midi != nxt.pitch_midi:
        raise ScoreEditError("a tie needs the same pitch on both notes")
    if cur.end_beat != nxt.start_beat:
        raise ScoreEditError(
            "a tie needs contiguous notes (the next note must start "
            "where this one ends)"
        )
    notes[note_index] = replace(cur, tie_start=True)
    notes[next_index] = replace(nxt, tie_stop=True)
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
    # #224: a canonical-deleted note at the target beat is restored —
    # restToNote is the canonical form of the UI's 復元 action and the
    # note keeps its id/pitch/span verbatim.
    for n in part.notes:
        if n.deleted and n.start_beat <= start_beat < n.end_beat:
            notes = list(part.notes)
            notes[notes.index(n)] = replace(n, deleted=False)
            return _retile_part(
                payload, part, notes, n.start_beat, n.end_beat
            )
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


def _warp_from_evidence(raw: Any) -> TimeWarp | None:
    """Rebuild the persisted seconds->ql warp (#226).

    Returns None when the evidence is missing/malformed so the caller
    can fall back to the synthetic path instead of failing the edit.
    """
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    try:
        if kind == "fixedBpm":
            bpm = raw.get("bpm")
            zero = raw.get("zeroSec")
            if not isinstance(bpm, (int, float)):
                return None
            return TimeWarp.fixed_bpm(
                float(bpm), float(zero) if isinstance(zero, (int, float)) else 0.0
            )
        if kind == "beatMap":
            anchors_raw = raw.get("anchors")
            if not isinstance(anchors_raw, list) or len(anchors_raw) < 2:
                return None
            anchors = []
            for a in anchors_raw:
                anchors.append(
                    BeatAnchor(
                        time_sec=float(a["timeSec"]),
                        score_pos_ql=Fraction(a["posQl"]),
                        source=BeatSource.BEAT_TRACKER,
                    )
                )
            return TimeWarp.from_anchors(anchors)
    except (KeyError, TypeError, ValueError):
        return None
    return None


def _events_from_evidence(
    raw: dict[str, Any], part_count: int
) -> list[list[RawNoteEvent]] | None:
    """Rebuild the per-part cleaned events persisted on the document.

    Returns None when the evidence shape does not match the score's
    current part count (the caller falls back to the synthetic path).
    """
    parts_raw = raw.get("parts")
    if not isinstance(parts_raw, list) or len(parts_raw) != part_count:
        return None
    out: list[list[RawNoteEvent]] = []
    try:
        for p in parts_raw:
            events_raw = p.get("events") if isinstance(p, dict) else None
            if not isinstance(events_raw, list):
                return None
            out.append([RawNoteEvent.from_dict(e) for e in events_raw])
    except (KeyError, TypeError, ValueError):
        return None
    return out


def _apply_requantize(
    document: ScoreDocument, overrides: dict[str, Any]
) -> tuple[ScoreRevisionPayload, str]:
    """Re-quantize every part under changed quantization settings (#130).

    #226: when the document carries raw transcription evidence (the
    # cleaned backend events + the original seconds->ql warp, persisted
    # by #223), the DP replays the REAL performance under the merged
    # profile — a finer min-duration can recover short notes the first
    # pass quantized away, and triplet policy changes re-decide tuplet
    # regions from actual timing. Without evidence (older projects,
    # hand-built documents) the legacy synthetic path re-rounds the
    # notation itself.

    Returns ``(payload, mode)`` where mode is ``rawEvidence`` or
    ``synthetic`` so the worker/UI can surface which path ran.
    """
    payload = document.payload
    settings = {**payload.quantization_settings, **overrides}
    profile = _profile_from_settings(settings)
    meter_map = _meter_map_from_payload(payload)
    beat_ql = beat_ql_of(payload)

    evidence = document.raw_evidence
    warp = _warp_from_evidence(evidence.get("warp") if evidence else None)
    evidence_parts = (
        _events_from_evidence(evidence, len(payload.parts))
        if evidence is not None
        else None
    )
    if warp is not None and evidence_parts is not None:
        return (
            _requantize_from_events(
                payload, evidence_parts, warp, meter_map, profile, beat_ql, settings
            ),
            "rawEvidence",
        )
    return (
        _requantize_synthetic(payload, meter_map, profile, beat_ql, settings),
        "synthetic",
    )


def _remap_note_ids(
    payload: ScoreRevisionPayload,
    new_parts_notes: list[tuple[tuple[QuantizedNote, ...], tuple[ScoreRest, ...]]],
    keep_source_ids: bool,
) -> tuple[Part, ...]:
    """Positional id preservation shared by both requantize paths.

    Old and new note lists are each in score order; index i of the new
    list inherits old note i's id. Extra new notes get fresh ids
    continuing the document's numbering; extra old ids disappear with
    their notes.

    ``keep_source_ids`` picks the source_event_ids policy: the
    evidence path keeps the new note's ids (they point at real
    persisted events), while the synthetic path restores the old
    note's ids — its synthetic rne-9xxxx ids resolve nowhere, so the
    old evidence link is the honest one to keep.
    """
    next_id = 0
    for part in payload.parts:
        for n in part.notes:
            try:
                next_id = max(next_id, int(str(n.id)[3:]) + 1)
            except ValueError:
                continue
    new_parts: list[Part] = []
    for part, (notes, rests) in zip(payload.parts, new_parts_notes, strict=True):
        old_sorted = sorted(part.notes, key=lambda n: (n.start_beat, str(n.id)))
        # #224: a deleted note must not resurrect. The event-id carry is
        # primary (a re-split note's halves share the old evidence), the
        # positional carry covers notes whose evidence link changed.
        deleted_event_ids = {
            e for n in part.notes if n.deleted for e in n.source_event_ids
        }
        remapped: list[QuantizedNote] = []
        for i, note in enumerate(notes):
            by_event = bool(deleted_event_ids & set(note.source_event_ids))
            if i < len(old_sorted):
                old = old_sorted[i]
                remapped.append(
                    replace(
                        note,
                        id=old.id,
                        source_event_ids=(
                            note.source_event_ids
                            if keep_source_ids
                            else old.source_event_ids
                        ),
                        deleted=old.deleted or by_event,
                    )
                )
            else:
                remapped.append(
                    replace(
                        note,
                        id=ScoreNoteId(f"sn-{next_id:06d}"),
                        deleted=by_event,
                    )
                )
                next_id += 1
        new_parts.append(replace(part, notes=tuple(remapped), rests=rests))
    return tuple(new_parts)


def _requantize_from_events(
    payload: ScoreRevisionPayload,
    evidence_parts: list[list[RawNoteEvent]],
    warp: TimeWarp,
    meter_map: MeterMap,
    profile: QuantizationProfile,
    beat_ql: Fraction,
    settings: dict[str, Any],
) -> ScoreRevisionPayload:
    """#226: true requantization — replay the persisted events through
    the ORIGINAL warp under the merged profile. Mirrors the pipeline:
    part 1 re-searches its alignment shift; later parts inherit it so
    the voices cannot drift against each other."""
    results: list[tuple[tuple[QuantizedNote, ...], tuple[ScoreRest, ...]]] = []
    shared_shift: float | None = None
    for events in evidence_parts:
        if not events:
            results.append(((), ()))
            continue
        alternatives = quantize_events(
            events,
            warp,
            meter_map,
            profile,
            alignment_shift_sec=shared_shift,
        )
        if not alternatives:
            results.append(((), ()))
            continue
        if shared_shift is None:
            shared_shift = alternatives[0].diagnostics.alignment_shift_sec
        event_by_id = {e.id: e for e in events}
        notes, rests, _conf, _onsets = _part_content(
            alternatives[0], beat_ql, event_by_id
        )
        results.append((tuple(notes), tuple(rests)))
    if all(not notes for notes, _rests in results):
        raise ScoreEditError(
            "re-quantization produced no notes for this score"
        )
    return replace(
        payload,
        parts=_remap_note_ids(payload, results, keep_source_ids=True),
        quantization_settings=settings,
    )


def _requantize_synthetic(
    payload: ScoreRevisionPayload,
    meter_map: MeterMap,
    profile: QuantizationProfile,
    beat_ql: Fraction,
    settings: dict[str, Any],
) -> ScoreRevisionPayload:
    """Legacy path (#130): replay the canonical notes as synthetic raw
    events through an identity warp (fixed 60 bpm — seconds == ql).
    Used when the document carries no raw evidence."""
    warp = TimeWarp.fixed_bpm(60.0)  # identity: seconds == quarterLength
    tr_rev = TranscriptionRevisionId(
        str(
            derive_transcription_revision_id(
                {"requantize": settings, "of": str(payload.revision_id())}
            )
        )
    )
    results: list[tuple[tuple[QuantizedNote, ...], tuple[ScoreRest, ...]]] = []
    for part in payload.parts:
        if not part.notes:
            results.append(((), ()))
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
        results.append((tuple(notes), tuple(rests)))
    return replace(
        payload,
        parts=_remap_note_ids(payload, results, keep_source_ids=False),
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


def _apply_alternative(
    payload: ScoreRevisionPayload,
    alt_notes: tuple[dict[str, Any], ...],
) -> ScoreRevisionPayload:
    """Swap in the runner-up interpretation for an ambiguous run (#208).

    The quantization_ambiguous issue embeds the rank-2 spans for its
    note ids; this edit replaces those canonical notes' positions and
    durations (ids and evidence survive), clears tie flags that no
    longer describe a contiguous pair, then re-tiles the affected
    measures — the same machinery every structural edit uses. A swap
    that would overlap a neighbouring note is rejected rather than
    silently clipped.
    """
    by_id = {e["id"]: e for e in alt_notes}
    matched: set[str] = set()
    new_parts: list[Part] = []
    for part in payload.parts:
        notes = list(part.notes)
        lo: Fraction | None = None
        hi = Fraction(0)
        touched = False
        for i, n in enumerate(notes):
            entry = by_id.get(str(n.id))
            if entry is None:
                continue
            matched.add(str(n.id))
            touched = True
            old_lo, old_hi = n.start_beat, n.end_beat
            notes[i] = replace(
                n,
                start_beat=entry["start"],
                duration_beats=entry["duration"],
                atoms=(),
            )
            lo = old_lo if lo is None else min(lo, old_lo)
            lo = min(lo, entry["start"])
            hi = max(hi, old_hi, entry["start"] + entry["duration"])
        if not touched:
            new_parts.append(part)
            continue
        notes.sort(key=lambda n: (n.start_beat, str(n.id)))
        # A moved boundary can break a tie pair's contiguity — drop
        # the stale flags instead of notating a tie across a gap.
        for j in range(len(notes) - 1):
            prev, cur = notes[j], notes[j + 1]
            if (prev.tie_start or cur.tie_stop) and (
                prev.end_beat != cur.start_beat
            ):
                notes[j] = replace(prev, tie_start=False)
                notes[j + 1] = replace(cur, tie_stop=False)
        for prev, cur in pairwise(notes):
            if prev.end_beat > cur.start_beat:
                raise ScoreEditError(
                    "the alternative rhythm overlaps a neighbouring "
                    "note"
                )
        new_parts.append(
            _retile_part(payload, part, notes, lo or Fraction(0), hi)
        )
    missing = sorted(set(by_id) - matched)
    if missing:
        raise ScoreEditError(
            f"alternative notes not found in the score: {missing}"
        )
    return replace(payload, parts=tuple(new_parts))


def _apply_triplet(
    payload: ScoreRevisionPayload, start_beat: Fraction
) -> ScoreRevisionPayload:
    """Force one beat into triplet notation (#212).

    The possible_triplet issue carries the region start in its
    evidence; this edit enables that beat as a TripletRegion and
    re-tiles the containing measures through the shared path — the
    realizer then writes triplet atoms where the grid fits. Compound
    meters reject the edit (the region model is simple-meter only).
    """
    beat_ql = beat_ql_of(payload)
    meter_map = _meter_map_from_payload(payload)
    start_ql = start_beat * beat_ql
    segment = meter_map.segment_at(start_ql)
    if segment.is_compound:
        raise ScoreEditError(
            "triplet notation is not supported in compound meter"
        )
    region = TripletRegion(
        start_ql=start_ql, beat_unit_ql=segment.beat_unit_ql
    )
    new_parts = tuple(
        _retile_part(
            payload,
            part,
            list(part.notes),
            start_beat,
            start_beat + region.beat_unit_ql / beat_ql,
            extra_regions=(region,),
        )
        for part in payload.parts
    )
    return replace(payload, parts=new_parts)


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


def _snap_to_measure_start(
    payload: ScoreRevisionPayload, start_beat: Fraction
) -> Fraction:
    """Snap a beat to its containing measure's start (#145/#249).

    Boundaries are notated at barlines; a beat past the content end
    snaps to the final measure's start.
    """
    spans = measure_spans(payload)
    snapped = spans[-1].start_beat if spans else Fraction(0)
    for span in spans:
        if span.start_beat <= start_beat < span.end_beat:
            snapped = span.start_beat
            break
    if snapped < 0:
        snapped = Fraction(0)
    return snapped


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
    snapped = _snap_to_measure_start(payload, start_beat)

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


def _apply_tempo_change_at(
    payload: ScoreRevisionPayload, bpm: float, start_beat: Fraction
) -> ScoreRevisionPayload:
    """Insert or update a tempo-map segment (#249).

    An exact start_beat match edits that segment in place (auto-tracked
    marks can sit mid-measure, and the UI names them by their exact
    beat); otherwise the edit snaps to the containing measure's start
    so a user-added mark lands on the barline. A change at beat 0 is
    the head tempo — same slot setTempo rewrites, but this path keeps
    the rest of the map addressable.
    """
    segments = list(payload.tempo_map)
    for i, seg in enumerate(segments):
        if seg.start_beat == start_beat:
            segments[i] = replace(seg, bpm=bpm)
            return replace(payload, tempo_map=tuple(segments))
    snapped = _snap_to_measure_start(payload, start_beat)
    for i, seg in enumerate(segments):
        if seg.start_beat == snapped:
            segments[i] = replace(seg, bpm=bpm)
            return replace(payload, tempo_map=tuple(segments))
    segments.append(TempoSegment(start_beat=snapped, bpm=bpm))
    segments.sort(key=lambda s: s.start_beat)
    return replace(payload, tempo_map=tuple(segments))


def _apply_remove_tempo_change(
    payload: ScoreRevisionPayload, start_beat: Fraction
) -> ScoreRevisionPayload:
    """Drop a tempo-map segment (#249); the head tempo cannot go.

    startBeat matches exactly (the UI passes the segment's own beat);
    startMeasure resolves to that measure's start first, so it only
    removes a mark sitting on the barline.
    """
    segments = list(payload.tempo_map)
    if not segments:
        raise ScoreEditError("the score has no tempo changes to remove")
    if start_beat == segments[0].start_beat:
        # The map's first segment anchors playback from the start —
        # removing it would leave the opening with no tempo at all.
        raise ScoreEditError(
            "the head tempo cannot be removed — use setTempo to change it"
        )
    kept = [s for s in segments if s.start_beat != start_beat]
    if len(kept) == len(segments):
        raise ScoreEditError(f"no tempo change at beat {start_beat}")
    return replace(payload, tempo_map=tuple(kept))


def _transposed(note: QuantizedNote, semitones: int) -> QuantizedNote:
    """Shift one canonical note's sounding pitch (#267/#261).

    MIDI 0..127 is a hard bound — the edit is rejected outright
    rather than silently clipped (the issue's acceptance: refuse
    out-of-range moves up front)."""
    new_pitch = note.pitch_midi + semitones
    if not (0 <= new_pitch <= 127):
        raise ScoreEditError(
            f"transpose would move note {note.id} to MIDI "
            f"{new_pitch} (outside 0-127)"
        )
    return replace(note, pitch_midi=new_pitch)


def _apply_transpose_range(
    payload: ScoreRevisionPayload,
    semitones: int,
    part_id: str | None,
    start_beat: Fraction | None,
    end_beat: Fraction | None,
) -> ScoreRevisionPayload:
    """Transpose every note in a range (#267).

    All bounds omitted = the whole score (the MVP octave arrange).
    A note belongs to the range when its onset falls inside
    [start_beat, end_beat); rests are layout, never transposed.
    The whole edit validates before anything moves — one out-of-
    range target rejects the batch instead of half-applying it.
    """
    if (
        start_beat is not None
        and end_beat is not None
        and end_beat <= start_beat
    ):
        raise ScoreEditError(
            f"edit.endBeat {end_beat} must be > startBeat {start_beat}"
        )
    if part_id is not None and not any(
        p.id == part_id for p in payload.parts
    ):
        raise ScoreEditError(f"no part {part_id} in the score")

    def in_range(n: QuantizedNote) -> bool:
        if start_beat is not None and n.start_beat < start_beat:
            return False
        return end_beat is None or n.start_beat < end_beat

    targets = [
        n
        for p in payload.parts
        if part_id is None or p.id == part_id
        for n in p.notes
        if in_range(n)
    ]
    if not targets:
        raise ScoreEditError("transposeRange matched no notes")
    # Validate before mutating anything (atomic rejection).
    for n in targets:
        if not (0 <= n.pitch_midi + semitones <= 127):
            raise ScoreEditError(
                f"transposeRange would move note {n.id} to MIDI "
                f"{n.pitch_midi + semitones} (outside 0-127)"
            )
    target_ids = {n.id for n in targets}
    return replace(
        payload,
        parts=tuple(
            replace(
                part,
                notes=tuple(
                    _transposed(n, semitones)
                    if n.id in target_ids
                    else n
                    for n in part.notes
                ),
            )
            for part in payload.parts
        ),
    )


def _edit_boundary_beat(
    payload: ScoreRevisionPayload, edit: ScoreEdit
) -> Fraction:
    """Resolve a key-boundary edit's position to a beat (#145).

    ``startBeat`` is used verbatim; ``startMeasure`` resolves through
    the shared measure layout so the UI can name the barline it sees
    (an implicit pickup answers to measure 0).
    """
    if edit.start_beat is not None:
        return edit.start_beat
    if edit.start_measure is None:
        raise ScoreEditError(
            f"{edit.kind} requires startBeat or startMeasure"
        )
    for span in measure_spans(payload):
        if span.number == edit.start_measure:
            return span.start_beat
    raise ScoreEditError(
        f"no measure {edit.start_measure} in the score"
    )


def apply_score_edit(
    document: ScoreDocument,
    edit: ScoreEdit,
    out_meta: dict[str, Any] | None = None,
) -> ScoreDocument:
    """Apply one §13 rhythm edit and return the rebuilt document.

    The payload's canonical notes keep their ids — review issues and
    client-side note edits stay attached. A new score revision falls
    out of the changed content automatically (content-derived ids).
    ``out_meta`` (optional) receives per-edit metadata — requantize
    reports ``requantizeMode`` (``rawEvidence`` | ``synthetic``) so the
    worker/UI can tell a true replay from the legacy re-round (#226).
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
    if edit.kind == "applyAlternative":
        if not edit.alternative_notes:
            raise ScoreEditError("applyAlternative requires notes")
        new_payload = _apply_alternative(payload, edit.alternative_notes)
        return replace(document, payload=new_payload)
    if edit.kind == "applyTriplet":
        if edit.start_beat is None:
            raise ScoreEditError("applyTriplet requires startBeat")
        new_payload = _apply_triplet(payload, edit.start_beat)
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
        new_payload, mode = _apply_requantize(document, edit.settings)
        if out_meta is not None:
            out_meta["requantizeMode"] = mode
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
        if edit.fifths is None or (
            edit.start_beat is None and edit.start_measure is None
        ):
            raise ScoreEditError(
                "keyChangeAt requires fifths and startBeat/startMeasure"
            )
        key = KeySignature(
            fifths=edit.fifths, mode=edit.mode or payload.key_signature.mode
        )
        new_payload = _apply_key_change_at(
            payload, key, _edit_boundary_beat(payload, edit)
        )
        return replace(document, payload=new_payload)
    if edit.kind == "removeKeyChange":
        new_payload = _apply_remove_key_change(
            payload, _edit_boundary_beat(payload, edit)
        )
        return replace(document, payload=new_payload)
    if edit.kind == "tempoChangeAt":
        if edit.bpm is None:
            raise ScoreEditError("tempoChangeAt requires bpm")
        new_payload = _apply_tempo_change_at(
            payload, edit.bpm, _edit_boundary_beat(payload, edit)
        )
        return replace(document, payload=new_payload)
    if edit.kind == "removeTempoChange":
        new_payload = _apply_remove_tempo_change(
            payload, _edit_boundary_beat(payload, edit)
        )
        return replace(document, payload=new_payload)
    if edit.kind == "setMetadata":
        if not edit.metadata:
            raise ScoreEditError("setMetadata requires metadata")
        # #271: document-level notation metadata — the payload (and
        # therefore the content-derived revision) is untouched.
        updates: dict[str, Any] = {}
        if "title" in edit.metadata:
            updates["title"] = edit.metadata["title"] or ""
        if "composer" in edit.metadata:
            updates["composer"] = edit.metadata["composer"] or None
        if "arranger" in edit.metadata:
            updates["arranger"] = edit.metadata["arranger"] or None
        return replace(document, **updates)
    if edit.kind == "transposeRange":
        if edit.semitones is None:
            raise ScoreEditError("transposeRange requires semitones")
        # #267: whole-score (or bounded) arrangement transpose —
        # pitch_midi is canonical content, so the revision changes.
        new_payload = _apply_transpose_range(
            payload,
            edit.semitones,
            edit.part_id,
            edit.start_beat,
            edit.end_beat,
        )
        return replace(document, payload=new_payload)
    if edit.kind == "transposeNote":
        if edit.semitones is None:
            raise ScoreEditError("transposeNote requires semitones")
        # #261: one canonical note's octave fix — same part-scan as
        # the other note edits below.
        for pi, part in enumerate(payload.parts):
            try:
                ni = _find_note(part, edit.note_id)
            except ScoreEditError:
                continue
            notes = list(part.notes)
            notes[ni] = _transposed(notes[ni], edit.semitones)
            new_parts = list(payload.parts)
            new_parts[pi] = replace(part, notes=tuple(notes))
            return replace(
                document,
                payload=replace(payload, parts=tuple(new_parts)),
            )
        raise ScoreEditError(
            f"note {edit.note_id} not found in the score"
        )
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
