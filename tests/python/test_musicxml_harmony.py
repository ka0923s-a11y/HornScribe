"""#44: MusicXML <harmony> chord-symbol export from ScoreDocument.chord_symbols."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import replace
from fractions import Fraction

from conftest import make_score
from hornscribe.domain.ids import ScoreNoteId
from hornscribe.domain.score import (
    ChordSymbol,
    Part,
    QuantizedNote,
    ScoreDocument,
)
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)


def _sym(
    start: str | int,
    end: str | int,
    root_pc: int,
    quality: str,
    *,
    confidence: float = 0.9,
    margin: float = 0.5,
    label: str = "",
) -> ChordSymbol:
    return ChordSymbol(
        start_beat=Fraction(start),
        end_beat=Fraction(end),
        root_pc=root_pc,
        quality=quality,
        confidence=confidence,
        margin=margin,
        label=label or quality,
    )


def _harmonies(xml: str) -> list[ET.Element]:
    part = ET.fromstring(xml).find("part")
    assert part is not None
    return list(part.iter("harmony"))


def _measure_harmonies(xml: str) -> list[list[ET.Element]]:
    part = ET.fromstring(xml).find("part")
    assert part is not None
    return [m.findall("harmony") for m in part.findall("measure")]


def _root_of(h: ET.Element) -> tuple[str, int]:
    r = h.find("root")
    assert r is not None
    return (r.findtext("root-step") or "", int(r.findtext("root-alter") or 0))


def _kind_of(h: ET.Element) -> tuple[str, str | None]:
    k = h.find("kind")
    assert k is not None
    return (k.text or "", k.get("text"))


def _offset_of(h: ET.Element) -> str | None:
    off = h.find("offset")
    return off.text if off is not None else None


def _doc_with(
    notes: list[tuple[int, int, int]],
    symbols: tuple[ChordSymbol, ...],
    **kw,
) -> ScoreDocument:
    return replace(make_score(notes, **kw), chord_symbols=symbols)


# --- emission ----------------------------------------------------------------


def test_no_symbols_no_harmony() -> None:
    xml = export_concert_musicxml(make_score([(60, 0, 1)]))
    assert "<harmony>" not in xml


def test_symbol_emits_harmony_at_measure_start() -> None:
    doc = _doc_with(
        [(60, 0, 4), (64, 4, 4)],
        (_sym(0, 4, 0, "maj", label="C"), _sym(4, 8, 7, "7", label="G7")),
    )
    per_measure = _measure_harmonies(export_concert_musicxml(doc))
    assert [len(hs) for hs in per_measure] == [1, 1]
    assert _root_of(per_measure[0][0]) == ("C", 0)
    assert _kind_of(per_measure[0][0]) == ("major", None)
    assert _root_of(per_measure[1][0]) == ("G", 0)
    assert _kind_of(per_measure[1][0]) == ("dominant", "7")
    assert _offset_of(per_measure[0][0]) is None


def test_jpop_kind_text_overrides_default_glyph() -> None:
    """m7b5 keeps the JPOP m7-5 spelling instead of a slash-circle."""
    doc = _doc_with(
        [(60, 0, 4)], (_sym(0, 4, 11, "m7b5", label="Bm7-5"),)
    )
    (h,) = _harmonies(export_concert_musicxml(doc))
    assert _root_of(h) == ("B", 0)
    assert _kind_of(h) == ("half-diminished", "m7-5")


def test_flats_and_sharps_root_spelling() -> None:
    """The flat/sharp policy follows the head key signature, matching
    the pipeline's own prefer_flats choice."""
    flat_doc = _doc_with(
        [(60, 0, 4)],
        (_sym(0, 4, 10, "7", label="Bb7"),),
        fifths=-2,
    )
    (h,) = _harmonies(export_concert_musicxml(flat_doc))
    assert _root_of(h) == ("B", -1)
    sharp_doc = _doc_with(
        [(60, 0, 4)],
        (_sym(0, 4, 10, "7", label="A#7"),),
        fifths=2,
    )
    (h,) = _harmonies(export_concert_musicxml(sharp_doc))
    assert _root_of(h) == ("A", 1)


def test_mid_measure_symbol_carries_offset_when_unanchored() -> None:
    """A chord starting mid-note lands before the next anchor with a
    negative <offset> back to its real position."""
    doc = _doc_with(
        [(60, 0, 4)],  # whole note; no anchor at beat 2
        (_sym(0, 2, 0, "maj"), _sym(2, 4, 7, "7")),
    )
    (h_first, h_mid) = _harmonies(export_concert_musicxml(doc))
    assert _offset_of(h_first) is None
    # offset = (beat-2 position) - (measure end), in divisions read
    # straight from the exported measure (music21 picks the value).
    root = ET.fromstring(export_concert_musicxml(doc))
    divisions = int(
        root.findtext("part/measure/attributes/divisions") or "1"
    )
    assert _offset_of(h_mid) == str(-2 * divisions)


def test_low_confidence_symbol_is_not_exported() -> None:
    """The export gate mirrors chord_uncertain: weak or contested
    calls stay out of baked notation."""
    doc = _doc_with(
        [(60, 0, 4), (64, 4, 4)],
        (
            _sym(0, 4, 0, "maj"),
            _sym(4, 8, 9, "min", confidence=0.2),
        ),
    )
    assert len(_harmonies(export_concert_musicxml(doc))) == 1
    contested = _doc_with(
        [(60, 0, 4)], (_sym(0, 4, 0, "maj", margin=0.01),)
    )
    assert _harmonies(export_concert_musicxml(contested)) == []


def test_contiguous_same_chord_segments_print_once() -> None:
    doc = _doc_with(
        [(60, 0, 8), (64, 8, 4)],
        (
            _sym(0, 4, 0, "maj"),
            _sym(4, 8, 0, "maj"),   # contiguous repeat -> merged
            _sym(8, 12, 5, "maj"),
        ),
    )
    per_measure = _measure_harmonies(export_concert_musicxml(doc))
    assert [len(hs) for hs in per_measure] == [1, 0, 1]


def test_gap_breaks_the_run_so_the_chord_restates() -> None:
    """A filtered middle segment separates two C spans - the second
    prints again instead of silently extending the first."""
    doc = _doc_with(
        [(60, 0, 4), (62, 4, 4), (64, 8, 4)],
        (
            _sym(0, 4, 0, "maj"),
            _sym(4, 8, 0, "maj", confidence=0.1),  # filtered
            _sym(8, 12, 0, "maj"),
        ),
    )
    per_measure = _measure_harmonies(export_concert_musicxml(doc))
    assert [len(hs) for hs in per_measure] == [1, 0, 1]


def test_horn_part_transposes_symbols_up_a_fifth() -> None:
    """Written-pitch parts carry transposed chord names so a symbol
    names the harmony in the key the player reads."""
    doc = _doc_with(
        [(60, 0, 4), (64, 4, 4)],
        (_sym(0, 4, 0, "maj"), _sym(4, 8, 9, "min")),
    )
    hs = _harmonies(export_horn_in_f_musicxml(doc))
    assert [_root_of(h) for h in hs] == [("G", 0), ("E", 0)]
    assert [_kind_of(h)[0] for h in hs] == ["major", "minor"]


def test_horn_part_respells_transposed_accidentals() -> None:
    """Concert Eb (flat key) transposes to written Bb, not A#."""
    doc = _doc_with(
        [(60, 0, 4)], (_sym(0, 4, 3, "maj"),), fifths=-3
    )
    (h,) = _harmonies(export_horn_in_f_musicxml(doc))
    assert _root_of(h) == ("B", -1)


def test_symbols_print_on_first_part_only() -> None:
    """Multi-part scores carry the symbols once, above the top staff."""
    doc = make_score([(60, 0, 4)])
    second = Part(
        id="part-2",
        name="Horn in F (2nd voice)",
        notes=(
            QuantizedNote(
                id=ScoreNoteId("sn-000100"),
                source_event_ids=(),
                pitch_midi=55,
                start_beat=Fraction(0),
                duration_beats=Fraction(4),
                velocity=70,
            ),
        ),
    )
    payload = replace(doc.payload, parts=(*doc.payload.parts, second))
    doc = replace(
        doc,
        payload=payload,
        chord_symbols=(_sym(0, 4, 0, "maj"),),
    )
    root = ET.fromstring(export_concert_musicxml(doc))
    parts = root.findall("part")
    assert len(parts) == 2
    assert len(list(parts[0].iter("harmony"))) == 1
    assert list(parts[1].iter("harmony")) == []


# --- document plumbing -------------------------------------------------------


def test_chord_symbols_survive_document_round_trip() -> None:
    doc = _doc_with(
        [(60, 0, 4)], (_sym(0, 4, 2, "m7", label="Dm7"),)
    )
    restored = ScoreDocument.from_dict(doc.to_dict())
    assert restored.chord_symbols == doc.chord_symbols
    assert restored.revision == doc.revision


def test_chord_symbols_do_not_change_revision() -> None:
    """Analysis metadata sits outside the payload - attaching a chord
    map never churns the content-derived score revision."""
    base = make_score([(60, 0, 4)])
    with_symbols = replace(base, chord_symbols=(_sym(0, 4, 0, "maj"),))
    assert with_symbols.revision == base.revision


def test_deterministic_output_with_symbols() -> None:
    doc = _doc_with(
        [(60, 0, 4), (62, 4, 4)],
        (_sym(0, 4, 0, "maj"), _sym(4, 8, 7, "7")),
    )
    assert export_concert_musicxml(doc) == export_concert_musicxml(doc)
