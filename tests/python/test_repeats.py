"""#385 stage 1: repeated-section detection on the lead staff."""

from __future__ import annotations

from fractions import Fraction

from conftest import make_score
from hornscribe.domain.review import ReviewReason, Severity
from hornscribe.domain.score import ChordSymbol, measure_spans
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.transcription.repeats import (
    _measure_signatures,
    find_repeat_runs,
    repeat_section_issues,
)

# Phrase A: four distinctive measures of quarter notes (16 notes).
_PHRASE = [
    (60, 62, 64, 65),  # pc_rel 0,2,4,5
    (67, 65, 64, 62),  # pc_rel 0,-2,-3,-5
    (64, 66, 67, 69),  # pc_rel 0,2,3,5
    (60, 60, 62, 64),  # pc_rel 0,0,2,4
]


def _phrase_notes(measure_start_beat: int, shift: int = 0):
    """Phrase A written at a measure boundary (4 notes/measure)."""
    out = []
    for m, pitches in enumerate(_PHRASE):
        for b, p in enumerate(pitches):
            out.append((p + shift, Fraction(measure_start_beat + m * 4 + b), Fraction(1)))
    return out


def _filler(measure_start_beat: int, measures: int):
    """Half-note pad, pitch-shifted per measure so filler measures do
    not match each other (an identical-measure vamp would itself be a
    legitimate repeat)."""
    out = []
    for m in range(measures):
        base = measure_start_beat + m * 4
        gm = base // 4  # absolute measure index - blocks stay distinct
        out.append((48 + 2 * (gm % 5), Fraction(base), Fraction(2)))
        out.append((55 + 3 * (gm % 5), Fraction(base + 2), Fraction(2)))
    return out


def _issues_for(notes, **kw):
    doc = make_score(notes)
    warp = TimeWarp.fixed_bpm(120.0)
    return repeat_section_issues(
        doc.payload,
        warp,
        Fraction(1),
        doc.payload.revision_id(),
        **kw,
    )


def test_four_measure_phrase_repeat_reported() -> None:
    notes = _phrase_notes(0) + _filler(16, 4) + _phrase_notes(32)
    issues = _issues_for(notes)
    assert len(issues) == 1
    i = issues[0]
    assert i.reason is ReviewReason.REPEATED_SECTION
    assert i.severity is Severity.INFO
    ev = i.evidence
    assert ev["measures"] == [{"start": 1, "end": 4}]
    (occ,) = ev["occurrences"]
    assert occ["startMeasure"] == 9
    assert occ["endMeasure"] == 12
    assert occ["transposition"] == 0
    assert occ["similarity"] >= 0.99
    # The marker spans the repeated copy: beats 32-48 at 120 bpm
    # (beat_ql = 1 ql/beat, 2 ql/sec) -> 16-24 s.
    assert i.time_range.start_sec == 16.0
    assert i.time_range.end_sec == 24.0
    assert i.canonical_note_ids  # anchors into the repeated span


def test_transposed_last_chorus_still_matches() -> None:
    """A +2 final chorus reports its transposition, not a miss."""
    notes = _phrase_notes(0) + _filler(16, 4) + _phrase_notes(32, shift=2)
    issues = _issues_for(notes)
    assert len(issues) == 1
    assert issues[0].evidence["occurrences"][0]["transposition"] == 2


def test_third_statement_joins_one_issue() -> None:
    notes = (
        _phrase_notes(0)
        + _filler(16, 4)
        + _phrase_notes(32)
        + _filler(48, 4)
        + _phrase_notes(64)
    )
    issues = _issues_for(notes)
    assert len(issues) == 1
    ev = issues[0].evidence
    assert ev["occurrenceCount"] == 2
    assert [o["startMeasure"] for o in ev["occurrences"]] == [9, 17]


def test_short_echo_is_not_a_section() -> None:
    """A two-measure echo is riffing, not a repeat section."""
    notes = _phrase_notes(0) + _filler(16, 8) + [
        (p, Fraction(48 + b), Fraction(1))
        for b, p in enumerate(_PHRASE[0] + _PHRASE[1])
    ]
    assert _issues_for(notes) == []


def test_different_melody_never_matches() -> None:
    notes = _phrase_notes(0) + _filler(16, 8)
    assert _issues_for(notes) == []


def test_ornament_difference_tolerated() -> None:
    """One changed note in a 16-note window stays a match."""
    repeat = _phrase_notes(32)
    repeat[3] = (repeat[3][0] + 3, repeat[3][1], repeat[3][2])  # ornament m.1
    notes = _phrase_notes(0) + _filler(16, 4) + repeat
    issues = _issues_for(notes)
    assert len(issues) == 1
    assert issues[0].evidence["occurrences"][0]["similarity"] >= 0.85


def test_sparse_pad_does_not_claim_a_section() -> None:
    """Whole-note drones repeating trivially prove nothing."""
    notes = [
        (60, Fraction(m * 4), Fraction(4)) for m in range(12)
    ]
    assert _issues_for(notes) == []


def test_run_detection_returns_canonical_windows() -> None:
    notes = _phrase_notes(0) + _filler(16, 4) + _phrase_notes(32)
    doc = make_score(notes)
    spans = measure_spans(doc.payload)
    sigs = _measure_signatures(doc.payload.parts[0].notes, spans)
    runs = find_repeat_runs(sigs)
    assert len(runs) == 1
    assert (runs[0].start, runs[0].length) == (0, 4)
    assert runs[0].occurrences[0].start == 8


# --- harmony track -----------------------------------------------------------

_PROG = (0, 7, 5, 9)  # I - V - iii - vi over four measures


def _chords_for_progression(measure_start_beat: int, measures: int, shift=0):
    """Two chord symbols per measure cycling the progression."""
    out = []
    for m in range(measures):
        base = measure_start_beat + m * 4
        root_a = _PROG[m % len(_PROG)]
        root_b = _PROG[(m + 1) % len(_PROG)]
        for off, r in ((0, root_a), (2, root_b)):
            out.append(
                ChordSymbol(
                    start_beat=Fraction(base + off),
                    end_beat=Fraction(base + off + 2),
                    root_pc=(r + shift) % 12,
                    quality="maj",
                    confidence=0.9,
                    margin=0.4,
                    label="x",
                )
            )
    return out


def test_chord_track_finds_section_repeat() -> None:
    """The harmony track detects an 8-measure progression repeat even
    when the melody over it varies."""
    notes = (
        _phrase_notes(0)
        + _filler(16, 4)
        + _phrase_notes(32, shift=3)
        + _filler(48, 4)
    )
    chords = (
        _chords_for_progression(0, 8)
        + _chords_for_progression(32, 8)
    )
    doc = make_score(notes)
    warp = TimeWarp.fixed_bpm(120.0)
    issues = repeat_section_issues(
        doc.payload,
        warp,
        Fraction(1),
        doc.payload.revision_id(),
        chord_symbols=tuple(chords),
    )
    assert len(issues) == 1
    i = issues[0]
    assert i.evidence["track"] == "chords"
    assert i.evidence["phraseMeasures"] == 8
    (occ,) = i.evidence["occurrences"]
    assert (occ["startMeasure"], occ["endMeasure"]) == (9, 16)
    assert occ["transposition"] == 0


def test_chord_track_short_echo_ignored() -> None:
    """Chords confined to a 4-measure echo never build an 8-measure
    window - empty measures are invisible to the flattened signature,
    so the coverage floor rejects the vacuous run."""
    chords = _chords_for_progression(0, 4) + _chords_for_progression(24, 4)
    issues = _issues_for(
        _phrase_notes(0) + _filler(16, 8), chord_symbols=tuple(chords)
    )
    assert issues == []


def test_no_chords_falls_back_to_melody() -> None:
    notes = _phrase_notes(0) + _filler(16, 4) + _phrase_notes(32)
    issues = _issues_for(notes, chord_symbols=())
    assert len(issues) == 1
    assert issues[0].evidence["track"] == "melody"
