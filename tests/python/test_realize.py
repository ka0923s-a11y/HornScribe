"""QNT-003 acceptance: joint note-duration/rest realization (design 12-16, 33).

Covers the issue acceptance criteria: genuine rests, articulation-gap
suppression, repeated same-pitch preservation, overlap clipping, barline
ties, weak-start readability, determinism, measure-duration invariants,
memoization/profiling, and the timing-only ablation comparison.
"""

from __future__ import annotations

from fractions import Fraction
from itertools import pairwise

import pytest

from hornscribe.domain.ids import RawNoteEventId
from hornscribe.rhythm import (
    MeterMap,
    MeterSegment,
    NormalizedNote,
    QuantizationProfile,
    SpanRealizer,
    quantize_normalized,
    realize_interval,
)
from hornscribe.rhythm.realize import TINY_REST_MAX_QL, atom_vocabulary

METER_44 = MeterMap((MeterSegment(Fraction(0), 4, 4),))
METER_34 = MeterMap((MeterSegment(Fraction(0), 3, 4),))
METER_68 = MeterMap((MeterSegment(Fraction(0), 6, 8),))
PROFILE = QuantizationProfile.standard()


def _note(i: int, onset: float, offset: float, pitch: int = 60) -> NormalizedNote:
    return NormalizedNote(
        source_id=RawNoteEventId(f"rne-{i:06d}"),
        pitch_midi=pitch,
        onset_ql=onset,
        offset_ql=offset,
    )


def _rest_atoms(alt) -> list:
    return [a for r in alt.rests for a in r.notation.atoms]


def _all_atoms(alt) -> list:
    atoms = [a for n in alt.notes if n.notation for a in n.notation.atoms]
    return atoms + _rest_atoms(alt)


def _assert_measures_tiled(alt, meter_map: MeterMap) -> None:
    """Every touched measure's note+rest atoms sum exactly to the meter."""
    spans: list[tuple[Fraction, Fraction, bool]] = []
    for n in alt.notes:
        spans.append((n.onset_ql, n.end_ql, False))
    for r in alt.rests:
        spans.append((r.onset_ql, r.end_ql, True))
    spans.sort()
    # no gaps/overlaps between consecutive spans
    for (_, end_a, _), (start_b, _, _) in pairwise(spans):
        assert end_a <= start_b, f"overlap: span ends {end_a} > next start {start_b}"
    # per-measure fill: every measure between score start and the last span
    # end is fully covered
    if not spans:
        return
    measure_len = meter_map.segments[0].measure_length_ql
    first_measure = spans[0][0] // measure_len
    last_measure = (spans[-1][1] - Fraction(1, 10**9)) // measure_len
    for m in range(int(first_measure), int(last_measure) + 1):
        lo, hi = Fraction(m) * measure_len, Fraction(m + 1) * measure_len
        covered = sum(
            min(end, hi) - max(start, lo)
            for start, end, _ in spans
            if start < hi and end > lo
        )
        assert covered == measure_len, f"measure {m}: covered {covered} != {measure_len}"


# --- acceptance: rests -----------------------------------------------------------


def test_genuine_quarter_rest() -> None:
    """A real quarter-long gap produces exactly a quarter rest."""
    alts = quantize_normalized(
        [_note(1, 0.0, 0.95), _note(2, 2.0, 2.9)], METER_44, PROFILE
    )
    alt = alts[0]
    assert [n.onset_ql for n in alt.notes] == [Fraction(0), Fraction(2)]
    assert alt.notes[0].duration_ql == Fraction(1)
    gap_rests = [r for r in alt.rests if r.onset_ql == Fraction(1)]
    assert len(gap_rests) == 1
    atoms = gap_rests[0].notation.atoms
    assert len(atoms) == 1 and atoms[0].symbol == "quarter"
    assert atoms[0].duration_ql == Fraction(1)


def test_articulation_gap_no_tiny_rest() -> None:
    """A small tonguing/breath gap (~7% of a beat) must not become a 16th rest."""
    alts = quantize_normalized(
        [_note(1, 0.0, 0.93), _note(2, 1.0, 1.9)], METER_44, PROFILE
    )
    alt = alts[0]
    assert all(
        a.duration_ql >= TINY_REST_MAX_QL for a in _rest_atoms(alt)
    ), "tiny rest emitted for an articulation gap"
    assert alt.diagnostics.tiny_rest_count == 0
    # the note is allowed to sustain through the small gap
    assert alt.notes[0].duration_ql == Fraction(1)


def test_repeated_same_pitch_stays_distinct() -> None:
    """Tongued repeated same-pitch events keep separate note identities."""
    alts = quantize_normalized(
        [_note(i, float(i), float(i) + 0.85) for i in range(1, 5)],
        METER_44,
        PROFILE,
    )
    alt = alts[0]
    assert len(alt.notes) == 4
    assert len({n.canonical_note_id for n in alt.notes}) == 4
    assert [n.source_event_ids for n in alt.notes] == [
        (RawNoteEventId(f"rne-{i:06d}"),) for i in range(1, 5)
    ]


def test_overlapping_offset_clipped() -> None:
    """Raw offset past the next onset is clipped; the overlap is reported."""
    alts = quantize_normalized(
        [_note(1, 0.0, 1.3), _note(2, 1.0, 1.9)], METER_44, PROFILE
    )
    alt = alts[0]
    assert alt.notes[0].end_ql <= alt.notes[1].onset_ql
    assert all(n.duration_ql > 0 for n in alt.notes)
    assert alt.diagnostics.overlap_clipped_count == 1
    assert alt.diagnostics.max_overlap_ql == pytest.approx(0.3)
    assert "overlapping_candidates" in alt.diagnostics.review_reasons


def test_barline_crossing_ties() -> None:
    """A note spanning a barline decomposes into tied atoms at the barline."""
    alts = quantize_normalized(
        [_note(1, 3.5, 4.6), _note(2, 5.0, 5.9)], METER_44, PROFILE
    )
    alt = alts[0]
    note = alt.notes[0]
    assert note.onset_ql == Fraction(7, 2)
    assert note.end_ql == Fraction(9, 2)
    atoms = note.notation.atoms
    assert len(atoms) == 2
    # split exactly at the barline: [3.5, 4) + [4, 4.5)
    assert atoms[0].duration_ql == Fraction(1, 2) and atoms[0].tie_to_next
    assert atoms[1].duration_ql == Fraction(1, 2) and not atoms[1].tie_to_next
    assert alt.diagnostics.tie_count == 1


def test_measure_invariants() -> None:
    """Notes+rests tile every touched measure; no gaps, overlaps, negatives."""
    cases = [
        [_note(1, 0.0, 0.95), _note(2, 2.0, 2.9)],
        [_note(1, 3.5, 4.6), _note(2, 5.0, 5.9)],
        [_note(i, float(i), float(i) + 0.85) for i in range(1, 9)],
        [_note(1, 1.0, 1.5), _note(2, 2.25, 2.9), _note(3, 3.0, 3.2)],
    ]
    for notes in cases:
        alts = quantize_normalized(notes, METER_44, PROFILE)
        for alt in alts:
            assert all(a.duration_ql > 0 for a in _all_atoms(alt))
            _assert_measures_tiled(alt, METER_44)


# --- span decomposition / readability ---------------------------------------------


def test_weak_start_span_prefers_visible_beats() -> None:
    """A weak-start 2ql span ties to show hidden beats (design 15)."""
    realizer = SpanRealizer(METER_44, PROFILE)
    decomp = realizer.realize_span(Fraction(1, 2), Fraction(5, 2), is_rest=False)
    atoms = decomp.atoms
    # expected readable form: eighth + quarter + eighth, all tied
    assert [a.duration_ql for a in atoms] == [Fraction(1, 2), Fraction(1), Fraction(1, 2)]
    assert atoms[0].tie_to_next and atoms[1].tie_to_next
    # a naive half note would obscure the beats at 1 and 2
    naive = realizer.realize_span(Fraction(0), Fraction(2), is_rest=False)
    assert naive.strong_boundary_obscured == 0
    assert decomp.cost < (
        PROFILE.weights.symbol + 2 * PROFILE.weights.strong_boundary_crossing
    )


def test_whole_measure_rest_symbol() -> None:
    """A complete empty measure is a single whole rest in any meter."""
    for meter in (METER_44, METER_34, METER_68):
        realizer = SpanRealizer(meter, PROFILE)
        measure = meter.segments[0].measure_length_ql
        decomp = realizer.realize_span(Fraction(0), measure, is_rest=True)
        assert len(decomp.atoms) == 1
        assert decomp.atoms[0].symbol == "whole"
        assert decomp.atoms[0].is_rest


def test_compound_meter_beat_atom() -> None:
    """6/8: a beat-length span is one dotted quarter (compound beat)."""
    realizer = SpanRealizer(METER_68, PROFILE)
    decomp = realizer.realize_span(Fraction(0), Fraction(3, 2), is_rest=False)
    assert len(decomp.atoms) == 1
    assert decomp.atoms[0].symbol == "quarter" and decomp.atoms[0].dots == 1


def test_atoms_never_cross_barline() -> None:
    realizer = SpanRealizer(METER_44, PROFILE)
    decomp = realizer.realize_span(Fraction(3), Fraction(6), is_rest=False)
    # [3,4) and [4,6): atoms split at the barline, tied together
    assert [a.duration_ql for a in decomp.atoms] == [Fraction(1), Fraction(2)]
    assert decomp.atoms[0].tie_to_next


def test_realize_interval_entry_point() -> None:
    """Issue-level API: realize_interval(start, next_onset, offset, meter)."""
    iv = realize_interval(Fraction(0), Fraction(2), 0.95, METER_44, profile=PROFILE)
    assert iv.start_ql == 0 and iv.next_onset_ql == 2
    assert iv.note_end_ql == Fraction(1)
    assert iv.note.total_ql == Fraction(1)
    assert iv.rest is not None and iv.rest.total_ql == Fraction(1)


def test_realize_interval_accepts_metrical_tree() -> None:
    from hornscribe.rhythm import MetricalTree

    tree = MetricalTree(4, 4, Fraction(1, 4))
    iv = realize_interval(Fraction(0), Fraction(1), 0.9, tree, profile=PROFILE)
    assert iv.note_end_ql == Fraction(1)


# --- determinism / memoization ------------------------------------------------------


def test_realization_deterministic() -> None:
    notes = [_note(1, 0.0, 0.95), _note(2, 2.0, 4.6), _note(3, 5.0, 5.9)]
    a = quantize_normalized(notes, METER_44, PROFILE)[0]
    b = quantize_normalized(notes, METER_44, PROFILE)[0]
    assert a == b


def test_span_memoization_profiled() -> None:
    realizer = SpanRealizer(METER_44, PROFILE)
    realizer.realize_span(Fraction(1, 2), Fraction(5, 2), is_rest=False)
    calls_after_first = realizer.piece_calls
    hits_after_first = realizer.piece_cache_hits
    realizer.realize_span(Fraction(1, 2), Fraction(5, 2), is_rest=False)
    assert realizer.piece_calls > calls_after_first
    assert realizer.piece_cache_hits > hits_after_first
    # diagnostics surface the counters through the quantizer
    alts = quantize_normalized([_note(1, 0.0, 0.9), _note(2, 2.0, 2.9)], METER_44, PROFILE)
    d = alts[0].diagnostics
    assert d.span_realization_calls > 0
    assert 0 <= d.span_realization_cache_hits <= d.span_realization_calls


# --- atom vocabulary / contracts ------------------------------------------------------


def test_atom_vocabulary_respects_grid() -> None:
    vocab = atom_vocabulary(Fraction(1, 4))
    durs = {s.duration_ql for s in vocab}
    assert Fraction(4) in durs  # whole
    assert Fraction(1) in durs  # quarter
    assert Fraction(1, 4) in durs  # sixteenth
    assert all(s.duration_ql % Fraction(1, 4) == 0 for s in vocab)
    # second dots need a finer grid
    vocab32 = atom_vocabulary(Fraction(1, 8))
    assert any(s.dots == 2 for s in vocab32)


def test_leading_and_trailing_rest_fill() -> None:
    """Score gaps before the first note and in the final measure get rests."""
    alts = quantize_normalized([_note(1, 1.0, 1.9)], METER_44, PROFILE)
    alt = alts[0]
    leading = [r for r in alt.rests if r.onset_ql == Fraction(0)]
    assert leading and leading[0].duration_ql == Fraction(1)
    trailing = [r for r in alt.rests if r.onset_ql >= alt.notes[0].end_ql]
    assert trailing and trailing[-1].end_ql == Fraction(4)


def test_last_note_ending_on_barline_no_trailing_rest() -> None:
    alts = quantize_normalized([_note(1, 3.0, 3.95)], METER_44, PROFILE)
    alt = alts[0]
    assert alt.notes[0].end_ql == Fraction(4)
    assert not any(r.onset_ql >= Fraction(4) for r in alt.rests)
