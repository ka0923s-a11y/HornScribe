"""QNT-004 acceptance: meter expansion, compound meter, pickup phase.

GitHub issue #18 (QUANTIZER_DESIGN.md sections 7, 22, 28): HSQ-v1 is
meter-aware beyond 4/4 — 3/4 and 2/4 measures close exactly, 6/8 treats
native eighth-note subdivisions as ordinary atoms (never tuplets), dotted
compound beats carry low notation complexity, a manual ``measure_phase_ql``
produces a partial first measure (measure 0), meter changes are honored
mid-piece, invalid phase fails safely, and meter-specific fixtures
round-trip through MusicXML.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Callable
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest
from music21 import converter

import rhythm_fixtures as fx
from hornscribe.domain.ids import RawNoteEventId
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)
from hornscribe.rhythm import (
    MeterError,
    MeterMap,
    MeterMapError,
    MeterSegment,
    NormalizedNote,
    QuantizationAlternative,
    QuantizationProfile,
    SpanRealizer,
    assemble_score_document,
    normalize_to_score_time,
    quantize_events,
    quantize_normalized,
)
from rhythm_fixtures import RhythmFixture

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "musicxml"
"""Committed MusicXML goldens (regenerate via scripts/generate_fixtures.py)."""

METER_44 = MeterMap((MeterSegment(Fraction(0), 4, 4),))
METER_34 = MeterMap((MeterSegment(Fraction(0), 3, 4),))
METER_24 = MeterMap((MeterSegment(Fraction(0), 2, 4),))
METER_68 = MeterMap((MeterSegment(Fraction(0), 6, 8),))
METER_44_PICKUP = MeterMap(
    (MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(3)),)
)


def _note(i: int, onset: float, offset: float, pitch: int = 60) -> NormalizedNote:
    return NormalizedNote(RawNoteEventId(f"rne-{i + 1:06d}"), pitch, onset, offset)


def _all_spans(alt: QuantizationAlternative) -> list[tuple[Fraction, Fraction]]:
    """Committed note+rest spans in position order."""
    return sorted(
        [(n.onset_ql, n.end_ql) for n in alt.notes]
        + [(r.onset_ql, r.onset_ql + r.notation.total_ql) for r in alt.rests]
    )


def _assert_measures_tiled(
    alt: QuantizationAlternative, meter_map: MeterMap
) -> None:
    """note+rest spans tile ``[score_start, final_barline)`` contiguously and
    every metrical measure inside is covered exactly once — phase-aware."""
    spans = _all_spans(alt)
    assert spans
    start = meter_map.segments[0].start_ql
    assert spans[0][0] == start
    for (_, prev_end), (next_start, _) in pairwise(spans):
        assert prev_end == next_start, "span tiling has a gap or overlap"
    end = spans[-1][1]
    # the run ends on a barline of the active segment (or a segment start)
    assert meter_map.segment_at(end).measure_offset_ql(end) == 0
    cuts = {b for b in meter_map.measure_boundaries(start, end) if start < b < end}
    cuts |= {s.start_ql for s in meter_map.segments if start < s.start_ql < end}
    for lo, hi in pairwise((start, *sorted(cuts), end)):
        covered = sum(
            min(e, hi) - max(s, lo) for s, e in spans if s < hi and e > lo
        )
        assert covered == hi - lo, f"measure [{lo}, {hi}) covered {covered}"


def _note_atom_shapes(alt: QuantizationAlternative) -> list[list[tuple[str, int]]]:
    return [
        [(a.symbol, a.dots) for a in (n.notation.atoms if n.notation else ())]
        for n in alt.notes
    ]


# --- simple meters: measures close exactly (issue acceptance) --------------------


def test_34_measures_close_exactly() -> None:
    fixture = fx.meter_34_quarters()
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    assert tuple(n.onset_ql for n in alt.notes) == fixture.expected_onsets_ql
    assert _note_atom_shapes(alt) == [[("quarter", 0)]] * 9
    _assert_measures_tiled(alt, fixture.meter_map)
    assert alt.diagnostics.meter == "3/4"
    assert alt.diagnostics.review_reasons == ()
    # three complete 3/4 bars: content ends on the barline, no rests needed
    assert alt.notes[-1].end_ql == Fraction(9)
    assert alt.rests == ()


def test_24_measures_close_exactly() -> None:
    fixture = fx.meter_24_eighths()
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    assert tuple(n.onset_ql for n in alt.notes) == fixture.expected_onsets_ql
    assert _note_atom_shapes(alt) == [[("eighth", 0)]] * 8
    _assert_measures_tiled(alt, fixture.meter_map)
    assert alt.diagnostics.meter == "2/4"
    assert alt.rests == ()


# --- 6/8 compound meter (issue acceptance) --------------------------------------


def test_68_native_eighths_are_not_tuplets() -> None:
    """Native eighth subdivisions of a compound beat are plain atoms —
    no tuplet labels, no tuplet-group diagnostics (design 7.3)."""
    fixture = fx.meter_68_eighths()
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    assert tuple(n.onset_ql for n in alt.notes) == fixture.expected_onsets_ql
    atoms = [a for n in alt.notes for a in (n.notation.atoms if n.notation else ())]
    assert len(atoms) == 12
    assert all(a.symbol == "eighth" and a.dots == 0 for a in atoms)
    assert all(a.tuplet is None for a in atoms)
    assert all(not a.tie_to_next and not a.is_rest for a in atoms)
    assert alt.diagnostics.meter == "6/8"
    _assert_measures_tiled(alt, fixture.meter_map)
    assert alt.rests == ()


def test_68_compound_dotted_beats_low_complexity() -> None:
    """Dotted-quarter compound beats realize as single dotted atoms — one
    symbol per beat, no ties, no rests (low notation complexity)."""
    fixture = fx.meter_68_dotted_beats()
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    assert _note_atom_shapes(alt) == [[("quarter", 1)]] * 4
    assert all(n.duration_ql == Fraction(3, 2) for n in alt.notes)
    assert alt.diagnostics.symbol_count == 4
    assert alt.diagnostics.tie_count == 0
    assert alt.rests == ()
    _assert_measures_tiled(alt, fixture.meter_map)


def test_68_metrical_tree_compound_shape() -> None:
    """6/8 tree: two compound beats of 3/2 ql, each split natively by three."""
    segment = METER_68.segments[0]
    assert segment.is_compound
    assert segment.beat_count == 2
    assert segment.beat_unit_ql == Fraction(3, 2)
    assert segment.measure_length_ql == Fraction(3)


def test_68_beat_boundary_rest_grouping() -> None:
    """Rest grouping preserves the compound beat boundary at 3/2 (design 16)."""
    realizer = SpanRealizer(METER_68, QuantizationProfile.standard())
    # [1,2) straddles the beat boundary at 3/2 -> two eighth rests
    atoms = realizer.realize_span(Fraction(1), Fraction(2), is_rest=True).notation.atoms
    assert [a.duration_ql for a in atoms] == [Fraction(1, 2), Fraction(1, 2)]
    # [0,3/2) is exactly one compound beat -> single dotted-quarter rest
    atoms = realizer.realize_span(Fraction(0), Fraction(3, 2), is_rest=True).notation.atoms
    assert [(a.symbol, a.dots) for a in atoms] == [("quarter", 1)]
    # a whole 6/8 measure -> one measure rest
    atoms = realizer.realize_span(Fraction(0), Fraction(3), is_rest=True).notation.atoms
    assert len(atoms) == 1 and atoms[0].is_rest


def test_meter_aware_rest_grouping_differs_by_meter() -> None:
    """The same absolute rest span notates differently under each meter."""
    profile = QuantizationProfile.standard()

    def rest_atoms(meter_map: MeterMap, lo: int, hi: int) -> list[str]:
        rlz = SpanRealizer(meter_map, profile).realize_span(
            Fraction(lo), Fraction(hi), is_rest=True
        )
        return [a.symbol for a in rlz.notation.atoms]

    # beats 2-3 of a 4/4 bar: two quarter rests (a half rest would hide beat 3)
    assert rest_atoms(METER_44, 1, 3) == ["quarter", "quarter"]
    # beats 2-3 of a 3/4 bar: a single half rest
    assert rest_atoms(METER_34, 1, 3) == ["half"]
    # 2/4 measure rest = whole rest atom
    assert rest_atoms(METER_24, 0, 2) == ["whole"]


# --- pickup / anacrusis via measure_phase_ql (issue acceptance) -------------------


def test_pickup_partial_first_measure() -> None:
    """A declared one-quarter pickup: measure 0 spans [0,1); the first full
    measure is index 1 — and the committed output tiles both."""
    fixture = fx.pickup_44_quarter()
    meter_map = fixture.meter_map
    assert meter_map is not None
    segment = meter_map.segments[0]
    assert segment.pickup_length_ql == Fraction(1)
    assert segment.first_downbeat_ql == Fraction(1)
    assert meter_map.measure_index(Fraction(0)) == 0
    assert meter_map.measure_index(Fraction(1)) == 1
    assert meter_map.measure_boundaries(Fraction(0), Fraction(10)) == (
        Fraction(1),
        Fraction(5),
        Fraction(9),
    )
    alt = quantize_events(fixture.events, fixture.warp, meter_map)[0]
    assert tuple(n.onset_ql for n in alt.notes) == fixture.expected_onsets_ql
    _assert_measures_tiled(alt, meter_map)
    # the note at 0 is the anacrusis inside measure 0; the trailing rest
    # completes the partial last measure [5,9) up to the next downbeat
    assert alt.rests[-1].onset_ql == Fraction(6)
    assert alt.rests[-1].onset_ql + alt.rests[-1].notation.total_ql == Fraction(9)
    assert alt.diagnostics.review_reasons == ()


def test_pickup_leading_rest_inside_partial_measure() -> None:
    """A rest inside the pickup measure tiles ``[0, pickup)`` exactly."""
    notes = tuple(_note(i, 0.5 + i, i + 0.9) for i in range(5))
    alt = quantize_normalized(notes, METER_44_PICKUP)[0]
    _assert_measures_tiled(alt, METER_44_PICKUP)
    # leading rest fills the first half of the pickup measure [0, 1/2)
    assert alt.rests[0].onset_ql == Fraction(0)
    assert alt.rests[0].notation.total_ql == Fraction(1, 2)
    assert alt.notes[0].onset_ql == Fraction(1, 2)
    # onset evidence inside the pickup measure -> no ambiguity flag
    assert "pickup_ambiguous" not in alt.diagnostics.review_reasons


# --- meter changes + re-quantization --------------------------------------------


def test_meter_change_mid_piece() -> None:
    """A mid-piece meter change tiles under each segment's own meter."""
    fixture = fx.meter_change_44_68()
    meter_map = fixture.meter_map
    assert meter_map is not None
    # 4/4 downbeats 0,4 then 6/8 downbeats 8,11 (measure lengths differ)
    assert meter_map.measure_boundaries(Fraction(0), Fraction(14)) == (
        Fraction(0),
        Fraction(4),
        Fraction(8),
        Fraction(11),
    )
    alt = quantize_events(fixture.events, fixture.warp, meter_map)[0]
    assert tuple(n.onset_ql for n in alt.notes) == fixture.expected_onsets_ql
    _assert_measures_tiled(alt, meter_map)
    assert alt.diagnostics.review_reasons == ()
    # a note must not span the meter-change boundary at 8
    assert all(n.end_ql <= Fraction(8) or n.onset_ql >= Fraction(8) for n in alt.notes)


def test_requantize_meter_change_without_amt() -> None:
    """Changing the meter map re-quantizes the same normalized evidence —
    no AMT re-run, no mutation of the normalized input (design 28)."""
    fixture = fx.meter_34_quarters()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    raw_before = [(n.source_id, n.pitch_midi, n.onset_ql, n.offset_ql) for n in notes]

    alt_34 = quantize_normalized(notes, METER_34)[0]
    alt_44 = quantize_normalized(notes, METER_44)[0]

    assert alt_34.diagnostics.meter == "3/4"
    assert alt_44.diagnostics.meter == "4/4"
    # identical onsets; measure structure (and therefore rests) differ
    assert [n.onset_ql for n in alt_34.notes] == [n.onset_ql for n in alt_44.notes]
    _assert_measures_tiled(alt_34, METER_34)
    _assert_measures_tiled(alt_44, METER_44)
    # raw evidence untouched by either run
    assert raw_before == [
        (n.source_id, n.pitch_midi, n.onset_ql, n.offset_ql) for n in notes
    ]


def test_candidates_respect_meter_coverage_start() -> None:
    """A map whose coverage starts mid-timeline must not leak candidates
    below the first segment start (previously crashed mid-DP)."""
    meter_map = MeterMap((MeterSegment(Fraction(8), 3, 4),))
    notes = (_note(0, 8.1, 8.9), _note(1, 9.0, 9.9))
    alt = quantize_normalized(notes, meter_map)[0]
    assert all(n.onset_ql >= Fraction(8) for n in alt.notes)
    _assert_measures_tiled(alt, meter_map)


# --- invalid / ambiguous phase (issue acceptance) --------------------------------


def test_off_grid_phase_fails_safely() -> None:
    """A phase that lands between grid points is invalid input — the run
    fails with MeterMapError instead of an opaque assertion mid-search."""
    bad = MeterMap((MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(1, 3)),))
    with pytest.raises(MeterMapError, match="notation grid"):
        quantize_normalized((_note(0, 0.0, 0.9),), bad)
    with pytest.raises(MeterMapError, match="notation grid"):
        SpanRealizer(bad, QuantizationProfile.standard())
    # same guarantee for an off-grid segment start
    bad_start = MeterMap((MeterSegment(Fraction(1, 3), 4, 4),))
    with pytest.raises(MeterMapError, match="notation grid"):
        quantize_normalized((_note(0, 0.5, 0.9),), bad_start)


def test_out_of_range_phase_rejected() -> None:
    """Phase must lie inside the measure (contract-level validation)."""
    with pytest.raises(MeterError, match="measure_phase_ql"):
        MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(4))
    with pytest.raises(MeterError, match="measure_phase_ql"):
        MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(-1))


def test_ambiguous_phase_review_reasons() -> None:
    """Ambiguous upstream-supplied phase surfaces ``pickup_ambiguous`` — the
    internal reason the ReviewIssue mapper consumes (design 22/40)."""
    # declared pickup measure with no onset inside it
    notes = tuple(_note(i, 2.0 + i, i + 2.9) for i in range(3))
    alt = quantize_normalized(notes, METER_44_PICKUP)[0]
    assert "pickup_ambiguous" in alt.diagnostics.review_reasons
    _assert_measures_tiled(alt, METER_44_PICKUP)  # output stays valid

    # nonzero phase on a mid-piece segment (partial measure at the change)
    mid_phase = MeterMap(
        (
            MeterSegment(Fraction(0), 4, 4),
            MeterSegment(Fraction(8), 4, 4, measure_phase_ql=Fraction(2)),
        )
    )
    notes2 = tuple(_note(i, float(i), i + 0.9) for i in range(10))
    alt2 = quantize_normalized(notes2, mid_phase)[0]
    assert "pickup_ambiguous" in alt2.diagnostics.review_reasons


# --- MusicXML bridge + golden round-trip (issue acceptance) -----------------------


def _score_for(fixture: RhythmFixture) -> tuple[QuantizationAlternative, object]:
    """Quantize a fixture and lift its best alternative into a ScoreDocument."""
    assert fixture.meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, fixture.meter_map)[0]
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    doc = assemble_score_document(
        alt,
        notes,
        fixture.meter_map,
        bpm=fixture.bpm or 120.0,
        title=fixture.name,
    )
    return alt, doc


def test_pickup_exports_implicit_measure_zero() -> None:
    """The declared anacrusis exports as measure 0 with implicit="yes"."""
    fixture = fx.pickup_44_quarter()
    _alt, doc = _score_for(fixture)
    assert doc.payload.pickup_beats == Fraction(1)
    assert doc.payload.time_signature.beats_per_measure == 4
    xml = export_concert_musicxml(doc)
    measures = ET.fromstring(xml).findall("part/measure")
    assert measures[0].get("number") == "0"
    assert measures[0].get("implicit") == "yes"


def test_score_document_bridge_carries_meter_changes() -> None:
    """QNT-006: a mid-piece meter change survives the bridge as canonical
    ``meter_changes`` content rather than being dropped or rejected."""
    fixture = fx.meter_change_44_68()
    meter_map = fixture.meter_map
    assert meter_map is not None
    alt = quantize_events(fixture.events, fixture.warp, meter_map)[0]
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    doc = assemble_score_document(alt, notes, meter_map)
    changes = doc.payload.meter_changes
    assert len(changes) == 2
    assert changes[0].start_beat == 0
    assert changes[0].time_signature.beats_per_measure == 4
    assert changes[1].start_beat == Fraction(8)  # ql 8, quarter beats
    assert (changes[1].time_signature.beats_per_measure,
            changes[1].time_signature.beat_unit) == (6, 8)


@pytest.mark.parametrize(
    "make",
    fx.METER_GOLDEN_FACTORIES,
    ids=[m().name for m in fx.METER_GOLDEN_FACTORIES],
)
def test_metered_quantize_deterministic_and_roundtrips(
    make: Callable[[], RhythmFixture],
) -> None:
    """Same input -> identical output; the lifted score parses and preserves
    the pitched rhythm through MusicXML."""
    fixture = make()
    alt, doc = _score_for(fixture)
    again, _ = _score_for(make())
    assert alt == again  # deterministic

    xml = export_concert_musicxml(doc)
    parsed = converter.parse(xml, format="musicxml")
    assert parsed.parts
    part = parsed.parts[0].flatten()
    # Canonical notes may emit several tied <note> elements (committed atom
    # ties and barline splits): merge each tied continuation into the note
    # it belongs to before comparing against canonical durations.
    got: list[tuple[int, Fraction]] = []
    for n in part.notes:
        if not hasattr(n, "pitch"):
            continue
        midi = n.pitch.midi
        ql = Fraction(str(n.quarterLength))
        if n.tie is not None and n.tie.type in ("stop", "continue") and got:
            prev_pitch, prev_ql = got[-1]
            assert prev_pitch == midi  # tied fragments share the pitch
            got[-1] = (prev_pitch, prev_ql + ql)
        else:
            got.append((midi, ql))
    want = [
        (int(p), d)
        for (p, d) in zip(
            (n.pitch_midi for n in normalize_to_score_time(fixture.events, fixture.warp)),
            (n.duration_ql for n in alt.notes),
            strict=True,
        )
    ]
    assert got == want


@pytest.mark.parametrize(
    "make",
    fx.METER_GOLDEN_FACTORIES,
    ids=[m().name for m in fx.METER_GOLDEN_FACTORIES],
)
def test_meter_golden_musicxml_files(make: Callable[[], RhythmFixture]) -> None:
    """Committed meter goldens equal regenerated export, byte for byte."""
    fixture = make()
    _alt, doc = _score_for(fixture)
    for kind, export in (
        ("concert", export_concert_musicxml),
        ("horn_in_f", export_horn_in_f_musicxml),
    ):
        path = FIXTURE_DIR / f"{fixture.name}_{kind}.musicxml"
        if not path.exists():
            pytest.skip(f"meter golden {path.name} not generated yet")
        expected = path.read_text(encoding="utf-8")
        assert export(doc) == expected
        # and the committed file is still valid MusicXML
        assert converter.parse(expected, format="musicxml").parts
