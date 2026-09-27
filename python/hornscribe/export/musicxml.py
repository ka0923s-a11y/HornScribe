"""ScoreDocument -> MusicXML 4.0 export (ENG-001; master plan §11, dev plan §13).

Pipeline::

    ScoreDocument -> music21 score -> MusicXML -> validate/patch -> final MusicXML

music21 carries the engraving-level details; HornScribe then normalizes the
emitted tree so exported documents are deterministic and identity-bearing:

* every pitched ``<note>`` carries ``id="hs-sn-*"`` via
  :func:`musicxml_note_id` — when engraving splits a canonical note into
  tied fragments, fragment ``k`` gets ``hs-sn-<id>-k`` so all ``xs:ID``
  values stay document-unique;
* canonical rest ``<note>`` elements carry presentation IDs
  ``hs-rest-*``; layout-only filler rests (secondary-voice gaps,
  non-strict measure padding) carry ``hs-layout-rest-*`` so they stay
  out of the canonical rest ordinal space (#241);
* ``score-part``/``part``/``score-instrument``/``midi-instrument`` IDs are
  normalized to deterministic ``P1..``/``I1..`` (music21 generates random
  ones);
* volatile ``<encoding-date>`` is removed so identical input yields
  byte-identical output;
* Horn in F parts carry written pitches *and*
  ``<transpose><diatonic>-4</diatonic><chromatic>-7</chromatic></transpose>``
  (MusicXML transpose is written -> sounding, i.e. -P5).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, replace
from fractions import Fraction
from itertools import groupby
from pathlib import Path

from music21.musicxml.m21ToXml import GeneralObjectExporter

from hornscribe.domain.ids import (
    ScoreNoteId,
    canonical_note_id_from_musicxml,
    is_musicxml_layout_rest_id,
    is_musicxml_note_id,
    musicxml_layout_rest_id,
    musicxml_note_id,
    musicxml_rest_id,
)
from hornscribe.domain.score import (
    ChordSymbol,
    PitchSpace,
    ScoreDocument,
    ScoreRevisionPayload,
    beat_ql_of,
    measure_spans,
)
from hornscribe.instruments import horn_f
from hornscribe.notation.to_music21 import build_music21_score

_XML_DECL = '<?xml version="1.0" encoding="utf-8"?>'
_MUSICXML_DOCTYPE = (
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
    '"http://www.musicxml.org/dtds/partwise.dtd">'
)


class ExportError(RuntimeError):
    """Export produced XML that violates HornScribe invariants."""


# ---------------------------------------------------------------------------
# export API
# ---------------------------------------------------------------------------


def export_musicxml(
    score: ScoreDocument,
    presentation: PitchSpace = PitchSpace.CONCERT,
) -> str:
    """Export *score* as a MusicXML 4.0 string.

    ``CONCERT`` emits sounding pitches with no transposition metadata;
    ``WRITTEN_HORN_F`` emits written (+P5) pitches with the Horn in F
    ``<transpose>`` element so a reader recovers sounding pitch.
    """
    m21_score = build_music21_score(score, presentation)
    raw = GeneralObjectExporter().parse(m21_score)
    text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
    return _normalize_musicxml(text, presentation, score)


def export_concert_musicxml(score: ScoreDocument) -> str:
    """``concert.musicxml``: canonical sounding pitches, no transposition."""
    return export_musicxml(score, PitchSpace.CONCERT)


def export_horn_in_f_musicxml(score: ScoreDocument) -> str:
    """``horn_in_f.musicxml``: written +P5 pitches plus -P5 transpose metadata."""
    return export_musicxml(score, PitchSpace.WRITTEN_HORN_F)


def write_musicxml(
    score: ScoreDocument,
    path: Path,
    presentation: PitchSpace = PitchSpace.CONCERT,
) -> Path:
    """Write :func:`export_musicxml` output to *path* (UTF-8)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(export_musicxml(score, presentation), encoding="utf-8", newline="\n")
    return path


# ---------------------------------------------------------------------------
# normalization / patching
# ---------------------------------------------------------------------------

_STEP_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _normalize_musicxml(
    xml_text: str,
    presentation: PitchSpace,
    score: ScoreDocument,
) -> str:
    root = ET.fromstring(xml_text)
    if root.tag != "score-partwise":
        raise ExportError(f"expected score-partwise root, got {root.tag!r}")
    root.set("version", "4.0")

    _strip_volatile_metadata(root)
    _normalize_part_and_instrument_ids(root)
    _assign_note_ids(root)
    swing_feel = score.payload.swing_feel
    if swing_feel is not None:
        _insert_swing_direction(root, swing_feel)
    _insert_harmony_symbols(root, score, presentation)

    if presentation is PitchSpace.WRITTEN_HORN_F:
        for part_el in root.findall("part"):
            _ensure_horn_transpose(part_el)
    else:
        for part_el in root.findall("part"):
            _forbid_transpose(part_el)

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    return f"{_XML_DECL}\n{_MUSICXML_DOCTYPE}\n{body}\n"


def _insert_swing_direction(root: ET.Element, swing_feel: Fraction) -> None:
    # #134: emit the swing marking music21 cannot express. Each part's
    # first measure gets a <direction> carrying visible words plus a
    # <sound><swing> playback hint. swing_feel is the detected offbeat
    # phase (fraction of a beat): 2/3 -> first=2 second=1, a softer
    # ~0.6 -> first=3 second=2.
    feel = swing_feel.limit_denominator(8)
    first = feel.numerator
    second = feel.denominator - feel.numerator
    for part_el in root.findall("part"):
        measure = part_el.find("measure")
        if measure is None:
            continue
        direction = ET.Element("direction")
        direction.set("placement", "above")
        dtype = ET.SubElement(direction, "direction-type")
        words = ET.SubElement(dtype, "words")
        words.text = "Swing"
        sound = ET.SubElement(direction, "sound")
        swing = ET.SubElement(sound, "swing")
        straight = ET.SubElement(swing, "straight")
        straight.text = "eighth"
        first_el = ET.SubElement(swing, "first")
        first_el.text = str(first)
        second_el = ET.SubElement(swing, "second")
        second_el.text = str(second)
        # Directions precede notes; insert after <attributes> when the
        # measure opens with one so the order stays schema-conformant.
        insert_at = 0
        for i, child in enumerate(list(measure)):
            if child.tag == "attributes":
                insert_at = i + 1
                break
        measure.insert(insert_at, direction)


# ---------------------------------------------------------------------------
# chord symbols (#44)
# ---------------------------------------------------------------------------

# Reliability gate mirrors transcription.chord's review thresholds -
# a segment weak enough to raise ``chord_uncertain`` is not baked
# into exported notation.
_HARMONY_MIN_CONFIDENCE = 0.35
_HARMONY_MIN_MARGIN = 0.04

# quality key -> (MusicXML <kind>, kind@text). The text override keeps
# the JPOP spelling ("m7-5") instead of a reader's default glyph
# (half-diminished would otherwise print as a slash-circle).
_QUALITY_KIND: dict[str, tuple[str, str]] = {
    "maj": ("major", ""),
    "min": ("minor", "m"),
    "7": ("dominant", "7"),
    "maj7": ("major-seventh", "maj7"),
    "m7": ("minor-seventh", "m7"),
    "m7b5": ("half-diminished", "m7-5"),
    "dim": ("diminished", "dim"),
    "aug": ("augmented", "aug"),
    "sus4": ("suspended-fourth", "sus4"),
}

# pitch class -> (root-step, root-alter), keyed by spelling policy.
_PC_SHARP: tuple[tuple[str, int], ...] = (
    ("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0),
    ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0),
)
_PC_FLAT: tuple[tuple[str, int], ...] = (
    ("C", 0), ("D", -1), ("D", 0), ("E", -1), ("E", 0), ("F", 0),
    ("G", -1), ("G", 0), ("A", -1), ("A", 0), ("B", -1), ("B", 0),
)


def _insert_harmony_symbols(
    root: ET.Element, score: ScoreDocument, presentation: PitchSpace
) -> None:
    """Emit ``<harmony>`` chord symbols on the first part (top staff).

    Symbols below the review-confidence floor are skipped - exported
    notation carries only calls the estimator stands behind. Runs of
    the same chord on truly contiguous segments collapse so a symbol
    prints once at the change, not twice per measure; a gap (a filtered
    or missing segment) breaks the run so the resuming chord restates.
    """
    printable = tuple(
        s
        for s in score.chord_symbols
        if s.confidence >= _HARMONY_MIN_CONFIDENCE
        and s.margin >= _HARMONY_MIN_MARGIN
        and s.quality in _QUALITY_KIND
    )
    if not printable:
        return
    part_el = root.find("part")
    if part_el is None:
        return
    measures = part_el.findall("measure")
    payload = score.payload
    spans = measure_spans(payload)
    beat_ql = beat_ql_of(payload)
    # Written-pitch parts carry transposed symbols, matching the notes
    # the player reads - a written G on the staff sits under the chord
    # it harmonizes in the part's own key.
    shift = (
        horn_f.HORN_F_CONCERT_TO_WRITTEN_SEMITONES
        if presentation is PitchSpace.WRITTEN_HORN_F
        else 0
    )
    # Same flat/sharp policy the pipeline used (head key signature).
    names = _PC_FLAT if payload.key_signature.fifths < 0 else _PC_SHARP

    # music21 emits divisions per-quarter once and reuses them; track
    # the running value so later measures inherit correctly.
    divisions = Fraction(1)
    measure_divisions: list[Fraction] = []
    for measure_el in measures:
        text = measure_el.findtext("attributes/divisions")
        if text:
            divisions = Fraction(int(text))
        measure_divisions.append(divisions)

    # Merge contiguous same-chord segments into print spans.
    print_spans: list[tuple[Fraction, ChordSymbol]] = []
    for sym in printable:
        if (
            print_spans
            and print_spans[-1][1].root_pc == sym.root_pc
            and print_spans[-1][1].quality == sym.quality
            and print_spans[-1][1].end_beat == sym.start_beat
        ):
            prev = print_spans[-1][1]
            print_spans[-1] = (
                print_spans[-1][0],
                replace(prev, end_beat=sym.end_beat),
            )
            continue
        print_spans.append((sym.start_beat, sym))

    by_measure: dict[int, list[tuple[Fraction, ChordSymbol]]] = {}
    for start, sym in print_spans:
        idx = next(
            (
                i
                for i, s in enumerate(spans)
                if s.start_beat <= start < s.end_beat
            ),
            None,
        )
        if idx is None or idx >= len(measures):
            continue
        by_measure.setdefault(idx, []).append(
            (start - spans[idx].start_beat, sym)
        )

    for idx, entries in sorted(by_measure.items()):
        measure_el = measures[idx]
        div = measure_divisions[idx]
        anchors, final_cursor = _measure_anchors(measure_el)
        inserts: list[tuple[int, ET.Element]] = []
        for pos_beats, sym in sorted(entries, key=lambda e: e[0]):
            pos_div = pos_beats * beat_ql * div
            anchor_i = len(list(measure_el))
            anchor_pos = final_cursor
            for i, cur in anchors:
                if cur >= pos_div:
                    anchor_i, anchor_pos = i, cur
                    break
            offset = pos_div - anchor_pos
            harmony = _harmony_element(sym, names, shift, offset)
            if harmony is not None:
                inserts.append((anchor_i, harmony))
        # Right-to-left so earlier anchors stay index-valid.
        for i, el in sorted(inserts, key=lambda t: -t[0]):
            measure_el.insert(i, el)


def _measure_anchors(
    measure_el: ET.Element,
) -> tuple[list[tuple[int, Fraction]], Fraction]:
    """(child index, cursor divisions) anchors a ``<harmony>`` may sit
    before, plus the cursor at measure end.

    Anchors are non-chord ``<note>`` children plus ``<direction>`` and
    ``<barline>`` - elements whose appearance marks a score-time
    position. ``<backup>``/``<forward>`` move the cursor without
    anchoring (a multi-voice measure's harmony still lands on the
    primary timeline)."""
    anchors: list[tuple[int, Fraction]] = []
    cursor = Fraction(0)
    for i, ch in enumerate(measure_el):
        if ch.tag == "note":
            if ch.find("chord") is None:
                anchors.append((i, cursor))
                dur = ch.findtext("duration")
                if dur:
                    cursor += Fraction(int(dur))
        elif ch.tag == "backup":
            dur = ch.findtext("duration")
            if dur:
                cursor -= Fraction(int(dur))
        elif ch.tag == "forward":
            dur = ch.findtext("duration")
            if dur:
                cursor += Fraction(int(dur))
        elif ch.tag in ("direction", "barline"):
            anchors.append((i, cursor))
    return anchors, cursor


def _harmony_element(
    sym: ChordSymbol,
    names: tuple[tuple[str, int], ...],
    shift: int,
    offset_div: Fraction,
) -> ET.Element | None:
    kind_text = _QUALITY_KIND.get(sym.quality)
    if kind_text is None:
        return None
    kind, text_attr = kind_text
    step, alter = names[(sym.root_pc + shift) % 12]
    harmony = ET.Element("harmony")
    root_el = ET.SubElement(harmony, "root")
    ET.SubElement(root_el, "root-step").text = step
    if alter:
        ET.SubElement(root_el, "root-alter").text = str(alter)
    kind_el = ET.SubElement(harmony, "kind")
    if text_attr:
        kind_el.set("text", text_attr)
    kind_el.text = kind
    if offset_div:
        off = ET.SubElement(harmony, "offset")
        off.text = (
            str(offset_div.numerator)
            if offset_div.denominator == 1
            else str(float(offset_div))
        )
    return harmony
def _strip_volatile_metadata(root: ET.Element) -> None:
    """Remove content that would break byte-determinism (encoding-date)."""
    for encoding in root.iter("encoding"):
        for child in list(encoding):
            if child.tag == "encoding-date":
                encoding.remove(child)


def _normalize_part_and_instrument_ids(root: ET.Element) -> None:
    """Replace music21's random part/instrument IDs with deterministic ones."""
    part_list = root.find("part-list")
    if part_list is None:
        raise ExportError("MusicXML document has no part-list")
    score_parts = part_list.findall("score-part")
    id_map: dict[str, str] = {}
    inst_counter = 0
    for idx, sp in enumerate(score_parts, start=1):
        old = sp.get("id")
        new = f"P{idx}"
        if old is not None:
            id_map[old] = new
        sp.set("id", new)
        # midi-instrument/@id references its score-instrument/@id, so a
        # score-instrument/midi-instrument pair keeps one shared ID.
        per_part: dict[str, str] = {}
        for child in sp:
            if child.tag in ("score-instrument", "midi-instrument"):
                old_inst = child.get("id") or ""
                if old_inst not in per_part:
                    inst_counter += 1
                    per_part[old_inst] = f"I{inst_counter}"
                child.set("id", per_part[old_inst])

    for part_el in root.findall("part"):
        old = part_el.get("id")
        if old is None or old not in id_map:
            raise ExportError(f"part element has unknown id {old!r}")
        part_el.set("id", id_map[old])


def _assign_note_ids(root: ET.Element) -> None:
    """Ensure every ``<note>`` carries a deterministic, document-unique ID.

    music21 duplicates ``note.id`` across fragments it splits (barline or
    complex-duration splits).  Pitched fragments of one canonical note are
    emitted consecutively, so the k-th occurrence of an export ID is
    rewritten to the fragment form ``hs-sn-<id>-k``.  Rest and fragment
    counters are document-global because ``note/@id`` is an ``xs:ID`` and
    must be unique across the whole document.
    """
    counts: dict[ScoreNoteId, int] = {}
    rest_ordinal = 0
    layout_ordinal = 0
    for part_el in root.findall("part"):
        for note_el in part_el.iter("note"):
            # #155: <chord/> members are welcome — each carries its own
            # canonical note id (music21 preserves member note ids).
            if note_el.find("rest") is not None:
                # #224: a canonical-deleted note renders as a rest but
                # keeps its hs-sn-* export id — fragment-number it like
                # a pitched note (the id is canonical, not a rest
                # ordinal) so selection/restore links survive.
                rest_nid = note_el.get("id")
                if rest_nid is not None and is_musicxml_note_id(rest_nid):
                    canonical = canonical_note_id_from_musicxml(rest_nid)
                    counts[canonical] = counts.get(canonical, 0) + 1
                    note_el.set(
                        "id", musicxml_note_id(canonical, counts[canonical])
                    )
                    continue
                # #241: layout-only filler rests (secondary-voice gaps,
                # non-strict measure padding) are marked by the renderer
                # and must NOT consume a canonical hs-rest-* ordinal —
                # the frontend resolves hs-rest-N to the N-th canonical
                # rest atom, so a filler would shift every later rest.
                if (
                    note_el.get("print-object") == "no"
                    or is_musicxml_layout_rest_id(note_el.get("id") or "")
                ):
                    layout_ordinal += 1
                    note_el.set("id", musicxml_layout_rest_id(layout_ordinal))
                    continue
                rest_ordinal += 1
                note_el.set("id", musicxml_rest_id(rest_ordinal))
                continue
            nid = note_el.get("id")
            if nid is None or not is_musicxml_note_id(nid):
                raise ExportError(f"pitched <note> missing HornScribe export id: {nid!r}")
            canonical = canonical_note_id_from_musicxml(nid)
            counts[canonical] = counts.get(canonical, 0) + 1
            note_el.set("id", musicxml_note_id(canonical, counts[canonical]))


def _ensure_horn_transpose(part_el: ET.Element) -> None:
    """Horn in F MusicXML must declare written -> sounding = -P5."""
    transpose = _first_transpose(part_el)
    expected = (
        str(horn_f.HORN_F_WRITTEN_TO_SOUNDING_DIATONIC),
        str(horn_f.HORN_F_WRITTEN_TO_SOUNDING_CHROMATIC),
    )
    if transpose is None:
        first_measure = part_el.find("measure")
        if first_measure is None:
            raise ExportError("horn part has no measures")
        attributes = first_measure.find("attributes")
        if attributes is None:
            attributes = ET.Element("attributes")
            first_measure.insert(0, attributes)
        transpose = ET.SubElement(attributes, "transpose")
        ET.SubElement(transpose, "diatonic").text = expected[0]
        ET.SubElement(transpose, "chromatic").text = expected[1]
        return
    diatonic = transpose.findtext("diatonic")
    chromatic = transpose.findtext("chromatic")
    if (diatonic, chromatic) != expected:
        raise ExportError(
            f"horn part transpose is diatonic={diatonic} chromatic={chromatic}, "
            f"expected {expected[0]}/{expected[1]}"
        )


def _forbid_transpose(part_el: ET.Element) -> None:
    transpose = _first_transpose(part_el)
    if transpose is None:
        return
    chromatic = transpose.findtext("chromatic")
    if chromatic not in (None, "0"):
        raise ExportError("concert export must not carry transposition metadata")


def _first_transpose(part_el: ET.Element) -> ET.Element | None:
    for measure in part_el.findall("measure"):
        attributes = measure.find("attributes")
        if attributes is not None:
            transpose = attributes.find("transpose")
            if transpose is not None:
                return transpose
    return None


# ---------------------------------------------------------------------------
# re-import helpers (round-trip verification)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExportedNote:
    """One ``<note>`` element read back from exported MusicXML."""

    export_id: str
    part_id: str
    written_midi: int | None  # None for rests
    sounding_midi: int | None  # written + part <transpose chromatic>
    canonical_id: ScoreNoteId | None  # None for rests


def _midi_from_pitch_el(pitch_el: ET.Element) -> int:
    step = pitch_el.findtext("step")
    octave = pitch_el.findtext("octave")
    if step is None or octave is None:
        raise ExportError("pitched <note> without step/octave")
    alter = int(float(pitch_el.findtext("alter") or 0))
    return (int(octave) + 1) * 12 + _STEP_PC[step] + alter


def iter_exported_notes(xml_text: str) -> tuple[ExportedNote, ...]:
    """Parse exported MusicXML back into per-note sounding identity.

    ``sounding_midi`` applies the part's first ``<transpose>`` chromatic
    value to the written pitch, which is the MuseScore/Verovio playback
    interpretation.
    """
    root = ET.fromstring(xml_text)
    if root.tag != "score-partwise":
        raise ExportError(f"expected score-partwise root, got {root.tag!r}")
    out: list[ExportedNote] = []
    for part_el in root.findall("part"):
        transpose = _first_transpose(part_el)
        chromatic = int(transpose.findtext("chromatic") or 0) if transpose is not None else 0
        for note_el in part_el.iter("note"):
            export_id = note_el.get("id") or ""
            if note_el.find("rest") is not None:
                out.append(ExportedNote(export_id, part_el.get("id") or "", None, None, None))
                continue
            pitch_el = note_el.find("pitch")
            if pitch_el is None:
                raise ExportError("non-rest <note> without <pitch>")
            written = _midi_from_pitch_el(pitch_el)
            canonical = (
                canonical_note_id_from_musicxml(export_id)
                if is_musicxml_note_id(export_id)
                else None
            )
            out.append(
                ExportedNote(
                    export_id=export_id,
                    part_id=part_el.get("id") or "",
                    written_midi=written,
                    sounding_midi=written + chromatic,
                    canonical_id=canonical,
                )
            )
    return tuple(out)


# ---------------------------------------------------------------------------
# rhythm reload / verification (QNT-006)
# ---------------------------------------------------------------------------
#
# The export path is *verified*, not trusted: the emitted MusicXML is read
# back and its committed rhythm — onsets, durations, rests, ties, tuplets,
# measure layout — is compared against the canonical ScoreDocument.  Any
# silent re-quantization or layout mutation inside music21 surfaces as a
# mismatch list rather than passing unnoticed.


@dataclass(frozen=True)
class ReloadedElement:
    """One ``<note>`` element with its absolute position on the beat axis."""

    kind: str  # "note" | "rest"
    onset_beats: Fraction
    duration_beats: Fraction
    canonical_id: ScoreNoteId | None = None
    tie_start: bool = False  # outgoing tie (<tie type="start">)
    tie_stop: bool = False  # incoming tie (<tie type="stop">)
    time_modification: tuple[int, int] | None = None
    written_midi: int | None = None  # #155: pitch for chord ordering


@dataclass(frozen=True)
class ReloadedMeasure:
    """One ``<measure>`` with its position and declared meter."""

    number: str
    start_beat: Fraction
    time_signature: tuple[int, int] | None  # declared here; None = inherited
    elements: tuple[ReloadedElement, ...]


def _beat_ql_from_xml(root: ET.Element) -> Fraction:
    """Canonical beat unit: the first declared ``<beat-type>``."""
    for part_el in root.findall("part"):
        for measure_el in part_el.findall("measure"):
            time_el = measure_el.find("attributes/time")
            if time_el is not None:
                beat_type = time_el.findtext("beat-type")
                if beat_type is None:
                    raise ExportError("<time> without <beat-type>")
                return Fraction(4, int(beat_type))
    raise ExportError("no <time> signature found in MusicXML")


def read_exported_rhythm(xml_text: str) -> dict[str, tuple[ReloadedMeasure, ...]]:
    """Parse exported MusicXML into positioned rhythm elements per part.

    Positions are exact ``Fraction`` beats on the canonical axis (the first
    ``<beat-type>`` defines the beat, matching ``beat_ql_of``).  ``<chord/>``
    members share their root's onset and do not advance the cursor;
    ``<backup>`` rewinds it for the next voice (#155).
    """
    root = ET.fromstring(xml_text)
    if root.tag != "score-partwise":
        raise ExportError(f"expected score-partwise root, got {root.tag!r}")
    beat_ql = _beat_ql_from_xml(root)

    parts: dict[str, tuple[ReloadedMeasure, ...]] = {}
    for part_el in root.findall("part"):
        part_id = part_el.get("id") or ""
        measures: list[ReloadedMeasure] = []
        divisions: Fraction | None = None
        cursor_ql = Fraction(0)
        last_dur_ql = Fraction(0)
        for measure_el in part_el.findall("measure"):
            measure_start_ql = cursor_ql
            declared_sig: tuple[int, int] | None = None
            elements: list[ReloadedElement] = []
            for child in measure_el:
                if child.tag == "attributes":
                    div = child.findtext("divisions")
                    if div is not None:
                        divisions = Fraction(int(div))
                    time_el = child.find("time")
                    if time_el is not None:
                        declared_sig = (
                            int(time_el.findtext("beats") or 0),
                            int(time_el.findtext("beat-type") or 0),
                        )
                elif child.tag == "note":
                    if divisions is None:
                        raise ExportError("<note> before any <divisions>")
                    is_chord = child.find("chord") is not None
                    dur_text = child.findtext("duration")
                    dur_ql = (
                        Fraction(int(dur_text)) / divisions
                        if dur_text is not None
                        else Fraction(0)
                    )
                    is_rest = child.find("rest") is not None
                    # #155: secondary-voice filler rests are exported
                    # print-object=no — they are layout, not canonical
                    # content, so verification skips them.
                    hidden = child.get("print-object") == "no"
                    # #241: layout fillers additionally carry an
                    # hs-layout-rest-* id — skip either marker.
                    layout = is_musicxml_layout_rest_id(
                        child.get("id") or ""
                    )
                    onset_ql = cursor_ql - last_dur_ql if is_chord else cursor_ql
                    if not is_chord:
                        cursor_ql += dur_ql
                        last_dur_ql = dur_ql
                    if is_rest and (hidden or layout):
                        continue
                    ties = {t.get("type") for t in child.findall("tie")}
                    tm = child.find("time-modification")
                    time_mod = (
                        (
                            int(tm.findtext("actual-notes") or 0),
                            int(tm.findtext("normal-notes") or 0),
                        )
                        if tm is not None
                        else None
                    )
                    export_id = child.get("id") or ""
                    canonical = (
                        canonical_note_id_from_musicxml(export_id)
                        if not is_rest and is_musicxml_note_id(export_id)
                        else None
                    )
                    pitch_el = child.find("pitch")
                    written = (
                        _midi_from_pitch_el(pitch_el)
                        if pitch_el is not None
                        else None
                    )
                    elements.append(
                        ReloadedElement(
                            kind="rest" if is_rest else "note",
                            onset_beats=onset_ql / beat_ql,
                            duration_beats=dur_ql / beat_ql,
                            canonical_id=canonical,
                            tie_start="start" in ties,
                            tie_stop="stop" in ties,
                            time_modification=time_mod,
                            written_midi=written,
                        )
                    )
                elif child.tag == "forward":
                    if divisions is None:
                        raise ExportError("<forward> before any <divisions>")
                    cursor_ql += Fraction(int(child.findtext("duration") or 0)) / divisions
                    last_dur_ql = Fraction(0)
                elif child.tag == "backup":
                    if divisions is None:
                        raise ExportError("<backup> before any <divisions>")
                    cursor_ql -= Fraction(int(child.findtext("duration") or 0)) / divisions
                    last_dur_ql = Fraction(0)
            measures.append(
                ReloadedMeasure(
                    number=measure_el.get("number") or "",
                    start_beat=measure_start_ql / beat_ql,
                    time_signature=declared_sig,
                    elements=tuple(elements),
                )
            )
        parts[part_id] = tuple(measures)
    return parts


@dataclass(frozen=True)
class _ExpectedEvent:
    """Canonical rhythm event for comparison: note or rest *span*."""

    kind: str  # "note" | "rest"
    onset_beats: Fraction
    duration_beats: Fraction
    canonical_id: ScoreNoteId | None = None
    tie_start: bool = False
    tie_stop: bool = False
    tuplet: bool | None = None  # None = unknown (atom-less legacy notes)


def _expected_events(payload: ScoreRevisionPayload, part_index: int) -> list[_ExpectedEvent]:
    """Canonical note/rest spans in document order for one part."""
    part = payload.parts[part_index]
    events: list[_ExpectedEvent] = []
    for n in part.notes:
        events.append(
            _ExpectedEvent(
                kind="note",
                onset_beats=n.start_beat,
                duration_beats=n.duration_beats,
                canonical_id=n.id,
                tie_start=n.tie_start,
                tie_stop=n.tie_stop,
                tuplet=(
                    any(a.tuplet is not None for a in n.atoms) if n.atoms else None
                ),
            )
        )
    for r in part.rests:
        events.append(
            _ExpectedEvent(
                kind="rest",
                onset_beats=r.start_beat,
                duration_beats=r.duration_beats,
            )
        )
    events.sort(key=lambda e: (e.onset_beats, 0 if e.kind == "note" else 1))
    return events


def _actual_events(measures: tuple[ReloadedMeasure, ...]) -> list[_ExpectedEvent]:
    """Group reloaded elements into note/rest spans for comparison.

    Pitched elements are grouped by canonical ID — fragments of one note
    stay consecutive in a single voice, but #155 chords interleave
    members between a note's fragments, so grouping must be global, not
    consecutive.  Rests still merge consecutively (secondary-voice
    filler rests are filtered upstream).
    """
    flat = [el for m in measures for el in m.elements]
    events: list[_ExpectedEvent] = []
    note_groups: dict[ScoreNoteId | None, list[ReloadedElement]] = {}
    pending_rests: list[ReloadedElement] = []

    def flush_rests() -> None:
        if not pending_rests:
            return
        onset = pending_rests[0].onset_beats
        end = pending_rests[-1].onset_beats + pending_rests[-1].duration_beats
        events.append(
            _ExpectedEvent(
                kind="rest", onset_beats=onset, duration_beats=end - onset
            )
        )
        pending_rests.clear()

    for el in flat:
        if el.kind == "rest":
            pending_rests.append(el)
            continue
        flush_rests()
        note_groups.setdefault(el.canonical_id, []).append(el)
    flush_rests()
    for ng in note_groups.values():
        onset = ng[0].onset_beats
        end = ng[-1].onset_beats + ng[-1].duration_beats
        events.append(
            _ExpectedEvent(
                kind="note",
                onset_beats=onset,
                duration_beats=end - onset,
                canonical_id=ng[0].canonical_id,
                tie_start=ng[-1].tie_start,
                tie_stop=ng[0].tie_stop,
                tuplet=any(el.time_modification is not None for el in ng),
            )
        )
    return events


def _event_sort_key(e: _ExpectedEvent) -> tuple[Fraction, int, str]:
    """Canonical comparison order: onset, notes before rests, then id.

    #155: simultaneous events (chords, voices) have no intrinsic
    document order — both sides sort by the same key so the comparison
    is order-insensitive yet deterministic.
    """
    return (
        e.onset_beats,
        0 if e.kind == "note" else 1,
        str(e.canonical_id) if e.canonical_id is not None else "",
    )


def verify_rhythm_roundtrip(
    score: ScoreDocument, xml_text: str, part_index: int = 0
) -> list[str]:
    """Compare exported MusicXML rhythm against the canonical score.

    Returns a list of human-readable mismatches (empty = rhythmic identity
    preserved).  Checks, in order: measure count/numbering, declared meter
    per measure, the grouped note/rest span sequence (onsets, durations,
    canonical IDs, note-level ties, tuplet presence), and that every split
    fragment of a canonical note is properly tie-joined.
    """
    payload = score.payload
    if part_index >= len(payload.parts):
        raise ExportError(f"part_index {part_index} out of range")
    parts = read_exported_rhythm(xml_text)
    problems: list[str] = []
    part_ids = sorted(parts)
    if len(part_ids) != len(payload.parts):
        problems.append(
            f"part count {len(part_ids)} != expected {len(payload.parts)}"
        )
        return problems
    measures = parts[part_ids[part_index]]
    spans = measure_spans(payload)

    if len(measures) != len(spans):
        problems.append(
            f"measure count {len(measures)} != expected {len(spans)}"
        )
    inherited_sig: tuple[int, int] | None = None
    for i, (m, span) in enumerate(zip(measures, spans, strict=False)):
        if m.number != str(span.number):
            problems.append(
                f"measure {i}: number {m.number!r} != expected {span.number!r}"
            )
        if m.start_beat != span.start_beat:
            problems.append(
                f"measure {m.number}: start {m.start_beat} != expected "
                f"{span.start_beat}"
            )
        sig = m.time_signature or inherited_sig
        if m.time_signature is not None:
            inherited_sig = m.time_signature
        expected_sig = (
            span.time_signature.beats_per_measure,
            span.time_signature.beat_unit,
        )
        if sig != expected_sig:
            problems.append(
                f"measure {m.number}: meter {sig} != expected {expected_sig}"
            )

    expected = sorted(_expected_events(payload, part_index), key=_event_sort_key)
    actual = sorted(_actual_events(measures), key=_event_sort_key)
    if len(actual) != len(expected):
        problems.append(
            f"event count {len(actual)} != expected {len(expected)}"
        )
    for i, (act, exp) in enumerate(zip(actual, expected, strict=False)):
        if act.kind != exp.kind:
            problems.append(f"event {i}: kind {act.kind} != {exp.kind}")
            continue
        label = (
            str(exp.canonical_id) if exp.canonical_id is not None else f"rest {i}"
        )
        if act.onset_beats != exp.onset_beats:
            problems.append(
                f"{label}: onset {act.onset_beats} != expected {exp.onset_beats}"
            )
        if act.duration_beats != exp.duration_beats:
            problems.append(
                f"{label}: duration {act.duration_beats} != expected "
                f"{exp.duration_beats}"
            )
        if exp.kind == "note":
            if act.canonical_id != exp.canonical_id:
                problems.append(
                    f"{label}: reloaded id {act.canonical_id} != "
                    f"{exp.canonical_id}"
                )
            if act.tie_start != exp.tie_start:
                problems.append(f"{label}: outgoing tie mismatch")
            if act.tie_stop != exp.tie_stop:
                problems.append(f"{label}: incoming tie mismatch")
            if exp.tuplet is not None and act.tuplet != exp.tuplet:
                problems.append(
                    f"{label}: tuplet presence {act.tuplet} != {exp.tuplet}"
                )

    # Fragment linkage: every split of a canonical note must be tie-joined.
    flat = [el for m in measures for el in m.elements if el.kind == "note"]
    for _cid, group in groupby(flat, key=lambda e: e.canonical_id):
        g = list(group)
        for i, el in enumerate(g):
            if i < len(g) - 1 and not el.tie_start:
                problems.append(
                    f"{el.canonical_id}: interior fragment at "
                    f"{el.onset_beats} lacks outgoing tie"
                )
            if i > 0 and not el.tie_stop:
                problems.append(
                    f"{el.canonical_id}: interior fragment at "
                    f"{el.onset_beats} lacks incoming tie"
                )
    return problems


def verify_horn_f_projection(
    score: ScoreDocument, xml_text: str, part_index: int = 0
) -> list[str]:
    """Verify the Horn in F presentation invariant (#370).

    ``horn_in_f.musicxml`` is the product's main artifact, not a
    decorative second output. For every pitched ``<note>`` carrying a
    canonical id, ``written + <transpose> chromatic`` must project back
    to the canonical sounding ``pitch_midi``; the part must declare the
    Horn in F ``<transpose>`` (-P5); and every measure's effective key
    signature must equal the canonical key through the same +1-fifth
    projection (``horn_f.written_key_signature``, the #257 policy that
    keeps signature and note spelling in agreement).

    Returns human-readable mismatch strings (empty = clean).
    """
    payload = score.payload
    if part_index >= len(payload.parts):
        raise ExportError(f"part_index {part_index} out of range")
    root = ET.fromstring(xml_text)
    if root.tag != "score-partwise":
        raise ExportError(f"expected score-partwise root, got {root.tag!r}")
    part_els = root.findall("part")
    problems: list[str] = []
    if len(part_els) != len(payload.parts):
        problems.append(
            f"part count {len(part_els)} != expected {len(payload.parts)}"
        )
        return problems
    part_el = part_els[part_index]
    part_id = part_el.get("id") or f"part {part_index + 1}"

    # 1. The written -> sounding declaration itself: without -P5 a
    # reader plays written pitch as sounding (a fifth too high).
    transpose = _first_transpose(part_el)
    expected_transpose = (
        str(horn_f.HORN_F_WRITTEN_TO_SOUNDING_DIATONIC),
        str(horn_f.HORN_F_WRITTEN_TO_SOUNDING_CHROMATIC),
    )
    actual_transpose = (
        (transpose.findtext("diatonic"), transpose.findtext("chromatic"))
        if transpose is not None
        else (None, None)
    )
    if actual_transpose != expected_transpose:
        problems.append(
            f"{part_id}: transpose {actual_transpose} != expected "
            f"{expected_transpose} (Horn in F written->sounding)"
        )

    # 2. Per-note sounding projection: written + chromatic must land on
    # the canonical pitch — catches transposed-wrong, dropped-octave and
    # respelled-to-wrong-semitone corruption the rhythm check cannot see.
    canonical_pitch = {
        note.id: note.pitch_midi for p in payload.parts for note in p.notes
    }
    for note in iter_exported_notes(xml_text):
        if note.part_id != part_id:
            continue
        if note.canonical_id is None or note.written_midi is None:
            continue  # rest
        expected_midi = canonical_pitch.get(note.canonical_id)
        if expected_midi is None:
            problems.append(f"{part_id} {note.export_id}: no canonical note")
        elif note.sounding_midi != expected_midi:
            problems.append(
                f"{part_id} {note.export_id}: sounding midi "
                f"{note.sounding_midi} != canonical {expected_midi}"
            )

    # 3. Key signatures: written key = canonical key +1 fifth (folded),
    # the same projection the note spelling used — a mismatch makes
    # printed accidentals contradict the signature.
    spans = measure_spans(payload)
    measures = part_el.findall("measure")
    inherited: tuple[int | None, str | None] = (None, None)
    key_changes = sorted(payload.key_changes, key=lambda k: k.start_beat)
    for i, (m_el, span) in enumerate(zip(measures, spans, strict=False)):
        key_el = m_el.find("attributes/key")
        if key_el is not None:
            fifths_text = key_el.findtext("fifths")
            inherited = (
                int(fifths_text) if fifths_text is not None else None,
                key_el.findtext("mode"),
            )
        concert_key = payload.key_signature
        for change in key_changes:
            if change.start_beat <= span.start_beat:
                concert_key = change.key_signature
            else:
                break
        expected_key = horn_f.written_key_signature(concert_key)
        if inherited[0] != expected_key.fifths:
            problems.append(
                f"{part_id} measure {m_el.get('number') or i}: key fifths "
                f"{inherited[0]} != expected written {expected_key.fifths} "
                f"(concert {concert_key.fifths})"
            )
        if inherited[1] is not None and inherited[1] != expected_key.mode:
            problems.append(
                f"{part_id} measure {m_el.get('number') or i}: key mode "
                f"{inherited[1]!r} != expected {expected_key.mode!r}"
            )
    return problems
