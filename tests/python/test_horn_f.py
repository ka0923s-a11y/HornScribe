"""ENG-001: Horn in F projection golden invariants (dev plan §12, Phase 1)."""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.ids import ScoreNoteId
from hornscribe.domain.score import KeySignature, Part, QuantizedNote
from hornscribe.instruments import horn_f
from hornscribe.instruments.horn_f import HornRangeStatus

# --- pitch projection golden invariants ---------------------------------------


@pytest.mark.parametrize(
    ("concert", "written"),
    [
        (60, 67),  # Concert C4 -> written G4
        (66, 73),  # Concert F#4 -> written C#5
        (58, 65),  # Concert Bb3 -> written F4
    ],
)
def test_concert_to_written_golden(concert: int, written: int) -> None:
    assert horn_f.concert_to_written_midi(concert) == written
    assert horn_f.written_to_concert_midi(written) == concert


def test_written_projection_is_perfect_fifth() -> None:
    assert horn_f.HORN_F_CONCERT_TO_WRITTEN_SEMITONES == 7
    for midi in (40, 55, 60, 72, 90):
        assert horn_f.concert_to_written_midi(midi) - midi == 7


def test_musicxml_transpose_constants_are_written_to_sounding() -> None:
    """<transpose> is written->sounding = -P5 (dev plan §12.2)."""
    assert horn_f.HORN_F_WRITTEN_TO_SOUNDING_DIATONIC == -4
    assert horn_f.HORN_F_WRITTEN_TO_SOUNDING_CHROMATIC == -7


# --- key signature golden invariants ------------------------------------------


@pytest.mark.parametrize(
    ("concert_fifths", "written_fifths"),
    [
        (0, 1),  # C major -> G major
        (-1, 0),  # F major -> C major
        (-2, -1),  # Bb major -> F major
        (3, 4),  # A major -> E major
        (-6, -5),  # Gb major -> Db major
    ],
)
def test_key_signature_transposition(concert_fifths: int, written_fifths: int) -> None:
    concert = KeySignature(fifths=concert_fifths, mode="major")
    written = horn_f.written_key_signature(concert)
    assert written.fifths == written_fifths
    assert written.mode == "major"
    assert horn_f.concert_key_signature(written) == concert


def test_key_signature_mode_preserved() -> None:
    written = horn_f.written_key_signature(KeySignature(fifths=-1, mode="minor"))
    assert written.fifths == 0
    assert written.mode == "minor"


def test_key_signature_bounds() -> None:
    with pytest.raises(ValueError):
        horn_f.written_key_signature(KeySignature(fifths=7))  # 8 sharps invalid
    with pytest.raises(ValueError):
        horn_f.concert_key_signature(KeySignature(fifths=-7))  # 8 flats invalid


# --- note / part projection ---------------------------------------------------


def _note(pitch: int = 60) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId("sn-000007"),
        source_event_ids=(),
        pitch_midi=pitch,
        start_beat=Fraction(1, 2),
        duration_beats=Fraction(3, 4),
        velocity=70,
        tie_start=True,
    )


def test_written_note_preserves_canonical_identity() -> None:
    n = _note(60)
    w = horn_f.written_note(n)
    assert w.id == n.id  # same canonical note ID, never a new note set
    assert w.pitch_midi == 67
    assert w.start_beat == n.start_beat
    assert w.duration_beats == n.duration_beats
    assert w.velocity == n.velocity
    assert w.tie_start == n.tie_start


def test_written_part_preserves_ids() -> None:
    part = Part(id="p1", name="Horn", notes=(_note(60), _note(58)))
    w = horn_f.written_part(part)
    assert [n.id for n in w.notes] == [n.id for n in part.notes]
    assert [n.pitch_midi for n in w.notes] == [67, 65]


def test_no_double_transposition() -> None:
    """Written pitch must never be projected twice (dev plan §12.3)."""
    once = horn_f.concert_to_written_midi(60)
    twice = horn_f.concert_to_written_midi(once)
    assert once == 67 and twice == 74
    # round trip is the identity: written -> sounding -> written
    assert horn_f.concert_to_written_midi(horn_f.written_to_concert_midi(once)) == once


# --- range warnings ------------------------------------------------------------


def test_range_status_bands() -> None:
    # sounding F#2 (41) -> written C#3 (48): inside caution band? no: normal low=47
    assert horn_f.sounding_range_status(60) is HornRangeStatus.NORMAL  # written G4
    assert horn_f.written_range_status(50) is HornRangeStatus.NORMAL
    assert horn_f.written_range_status(45) is HornRangeStatus.CAUTION
    assert horn_f.written_range_status(30) is HornRangeStatus.EXTREME
    assert horn_f.written_range_status(100) is HornRangeStatus.EXTREME
