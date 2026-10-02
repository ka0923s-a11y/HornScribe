"""#156: B-flat written-pitch projection golden invariants.

Mirrors test_horn_f.py - the +M2 concert->written projection, the -M2
MusicXML <transpose> declaration, the +2-fifths key projection and the
range bands that shift with the projection.
"""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.ids import ScoreNoteId
from hornscribe.domain.score import (
    KeySignature,
    Part,
    PitchSpace,
    QuantizedNote,
)
from hornscribe.instruments import b_flat, horn_f, transposition
from hornscribe.instruments.b_flat import BFlatRangeStatus

# --- pitch projection golden invariants ---------------------------------------


@pytest.mark.parametrize(
    ("concert", "written"),
    [
        (60, 62),  # Concert C4 -> written D4
        (58, 60),  # Concert Bb3 -> written C4
        (66, 68),  # Concert F#4 -> written G#4
    ],
)
def test_concert_to_written_golden(concert: int, written: int) -> None:
    assert b_flat.concert_to_written_midi(concert) == written
    assert b_flat.written_to_concert_midi(written) == concert


def test_written_projection_is_major_second() -> None:
    assert b_flat.B_FLAT_CONCERT_TO_WRITTEN_SEMITONES == 2
    for midi in (40, 55, 60, 72, 90):
        assert b_flat.concert_to_written_midi(midi) - midi == 2


def test_musicxml_transpose_constants_are_written_to_sounding() -> None:
    """<transpose> is written->sounding = -M2."""
    assert b_flat.B_FLAT_WRITTEN_TO_SOUNDING_DIATONIC == -1
    assert b_flat.B_FLAT_WRITTEN_TO_SOUNDING_CHROMATIC == -2


# --- key signature golden invariants ------------------------------------------


@pytest.mark.parametrize(
    ("concert_fifths", "written_fifths"),
    [
        (0, 2),  # C major -> D major
        (-2, 0),  # Bb major -> C major
        (-1, 1),  # F major -> G major
        (3, 5),  # A major -> B major
        (-6, -4),  # Gb major -> Ab major
    ],
)
def test_key_signature_transposition(concert_fifths: int, written_fifths: int) -> None:
    concert = KeySignature(fifths=concert_fifths, mode="major")
    written = b_flat.written_key_signature(concert)
    assert written.fifths == written_fifths
    assert written.mode == "major"
    assert b_flat.concert_key_signature(written) == concert


def test_key_signature_mode_preserved() -> None:
    written = b_flat.written_key_signature(KeySignature(fifths=-2, mode="minor"))
    assert written.fifths == 0
    assert written.mode == "minor"


def test_written_key_signature_folds_enharmonically() -> None:
    """Concert +6 (F# major) -> written +8 folds to -4 (Ab major):
    same sounding pitch collection, readable signature."""
    written = b_flat.written_key_signature(KeySignature(fifths=6, mode="major"))
    assert written.fifths == -4
    assert written.mode == "major"
    # And the inverse: written -7 (Cb) -> concert -9 folds to +3 (A major).
    concert = b_flat.concert_key_signature(KeySignature(fifths=-7, mode="minor"))
    assert concert.fifths == 3
    assert concert.mode == "minor"


def test_written_fifths_matches_key_signature_projection() -> None:
    for concert_fifths in range(-7, 8):
        ks = b_flat.written_key_signature(
            KeySignature(fifths=concert_fifths, mode="major")
        )
        assert ks.fifths == b_flat.written_fifths(concert_fifths)
        assert -7 <= ks.fifths <= 7


def test_key_signature_roundtrip_in_range() -> None:
    for concert_fifths in range(-6, 6):
        concert = KeySignature(fifths=concert_fifths, mode="major")
        written = b_flat.written_key_signature(concert)
        assert b_flat.concert_key_signature(written) == concert


# --- note / part projection ----------------------------------------------------


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
    w = b_flat.written_note(n)
    assert w.id == n.id
    assert w.pitch_midi == 62
    assert w.start_beat == n.start_beat
    assert w.duration_beats == n.duration_beats
    assert w.velocity == n.velocity
    assert w.tie_start == n.tie_start


def test_written_part_preserves_ids() -> None:
    part = Part(id="p1", name="Horn", notes=(_note(60), _note(58)))
    w = b_flat.written_part(part)
    assert [n.id for n in w.notes] == [n.id for n in part.notes]
    assert [n.pitch_midi for n in w.notes] == [62, 60]


def test_no_double_transposition() -> None:
    once = b_flat.concert_to_written_midi(60)
    twice = b_flat.concert_to_written_midi(once)
    assert once == 62 and twice == 64
    assert b_flat.concert_to_written_midi(
        b_flat.written_to_concert_midi(once)
    ) == once


# --- range warnings ------------------------------------------------------------


def test_range_status_bands() -> None:
    assert b_flat.sounding_range_status(60) is BFlatRangeStatus.NORMAL
    assert b_flat.written_range_status(52) is BFlatRangeStatus.NORMAL
    assert b_flat.written_range_status(40) is BFlatRangeStatus.CAUTION
    assert b_flat.written_range_status(30) is BFlatRangeStatus.EXTREME
    assert b_flat.written_range_status(100) is BFlatRangeStatus.EXTREME


def test_sounding_range_matches_horn_f() -> None:
    """The +2 projection against +2-shifted bands makes a sounding pitch
    classify identically in the F and B-flat views."""
    for midi in range(30, 100):
        assert (
            b_flat.sounding_range_status(midi).value
            == horn_f.sounding_range_status(midi).value
        )


# --- transposition spec table --------------------------------------------------


def test_spec_table_binds_the_constants() -> None:
    """The shared spec lookup must expose the module constants verbatim -
    this is the anti-drift contract for to_music21/musicxml."""
    f_spec = transposition.spec_for(PitchSpace.WRITTEN_HORN_F)
    b_spec = transposition.spec_for(PitchSpace.WRITTEN_B_FLAT)
    assert f_spec is not None and b_spec is not None
    assert f_spec.concert_to_written_semitones == 7
    assert f_spec.written_to_sounding_chromatic == -7
    assert b_spec.concert_to_written_semitones == 2
    assert b_spec.written_to_sounding_diatonic == -1
    assert b_spec.written_to_sounding_chromatic == -2
    assert transposition.spec_for(PitchSpace.CONCERT) is None


def test_spec_helpers_are_identity_for_concert() -> None:
    key = KeySignature(fifths=-3, mode="minor")
    assert transposition.concert_to_written_midi(60, PitchSpace.CONCERT) == 60
    assert transposition.written_fifths(-3, PitchSpace.CONCERT) == -3
    assert (
        transposition.written_key_signature(key, PitchSpace.CONCERT) == key
    )
