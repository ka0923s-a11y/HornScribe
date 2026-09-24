"""Key-aware enharmonic spelling tests (#165).

The spelling picks the enharmonic name whose circle-of-fifths position
sits closest to the key's diatonic block; chromatic notes get flagged
via is_diatonic for the pitch_spelling_ambiguous review issue (#166).
"""

from __future__ import annotations

from fractions import Fraction

import pytest

from hornscribe.domain.score import KeyChange, KeySignature
from hornscribe.notation.tone_spelling import (
    fifths_at_beat,
    is_diatonic,
    spell_midi,
    spell_name,
)


class TestDiatonicSpelling:
    """Diatonic pitch classes spell with the key's own note names."""

    @pytest.mark.parametrize(
        ("midi", "fifths", "expected"),
        [
            (60, 0, "C4"),  # C major: C natural
            (65, -1, "F4"),  # F major: F natural
            (70, -1, "B-4"),  # F major: Bb (diatonic flat)
            (66, 1, "F#4"),  # G major: F# (diatonic sharp)
            (63, -3, "E-4"),  # Eb major: Eb (diatonic flat)
            (61, 2, "C#4"),  # D major: C# (diatonic sharp)
            (68, -4, "A-4"),  # Ab major: Ab (diatonic flat)
        ],
    )
    def test_diatonic_note_names(self, midi, fifths, expected):
        assert spell_name(midi, fifths) == expected


class TestChromaticSpelling:
    """Chromatic notes lean toward the key's accidental direction."""

    @pytest.mark.parametrize(
        ("midi", "fifths", "expected"),
        [
            (61, 0, "C#4"),  # C major: C# not Db
            (66, 0, "F#4"),  # C major: F# not Gb
            (68, 0, "G#4"),  # C major: G# not Ab
            (66, -3, "G-4"),  # Eb major: Gb not F#
            (61, -3, "D-4"),  # Eb major: Db not C#
            (63, 2, "D#4"),  # D major (sharp key): D# not Eb
            (70, 2, "A#4"),  # D major (sharp key): A# not Bb
        ],
    )
    def test_chromatic_lean(self, midi, fifths, expected):
        assert spell_name(midi, fifths) == expected

    def test_flat_key_prefers_flat_spelling(self):
        # In a flat key the chromatic pitch class spells with a flat.
        letter, alter, _oct = spell_midi(66, -3)
        assert alter == -1

    def test_sharp_key_prefers_sharp_spelling(self):
        letter, alter, _oct = spell_midi(63, 2)
        assert (letter, alter) == ("D", 1)  # D# over Eb in D major

    def test_never_double_accidental(self):
        # No key produces a double sharp/flat (|alter| <= 1 always).
        for fifths in range(-7, 8):
            for pc in range(12):
                _letter, alter, _oct = spell_midi(pc, fifths)
                assert abs(alter) <= 1, (pc, fifths)

    def test_octave_is_correct(self):
        # Spelling must not shift the octave off the sounding pitch.
        letter, alter, octave = spell_midi(60, -6)  # C in Gb major -> C4
        assert (letter, alter, octave) == ("C", 0, 4)
        # B#3 (pc 0, octave 3) vs C4 — same key number, different octave.
        letter, alter, octave = spell_midi(72, 5)  # C5 in B major -> B#4
        assert (letter, alter, octave) == ("B", 1, 4)


class TestIsDiatonic:
    def test_diatonic_pc(self):
        assert is_diatonic(65, -1)  # F in F major
        assert is_diatonic(70, -1)  # Bb in F major
        assert is_diatonic(66, 1)  # F# in G major

    def test_chromatic_pc(self):
        assert not is_diatonic(66, -1)  # F#/Gb in F major
        assert not is_diatonic(61, 0)  # C#/Db in C major
        assert not is_diatonic(69, -4)  # A natural in Ab major is chromatic

    def test_ab_major_ab_is_diatonic(self):
        # Ab major (-4): Ab (pc 8) is diatonic, not chromatic.
        assert is_diatonic(68, -4)


class TestFifthsAtBeat:
    def _changes(self):
        return (
            KeyChange(Fraction(0), KeySignature(fifths=0, mode="major")),
            KeyChange(Fraction(8), KeySignature(fifths=-1, mode="major")),
        )

    def test_head_key_without_changes(self):
        assert fifths_at_beat(-3, (), Fraction(0)) == -3
        assert fifths_at_beat(-3, (), Fraction(99)) == -3

    def test_latest_change_wins(self):
        changes = self._changes()
        assert fifths_at_beat(0, changes, Fraction(0)) == 0
        assert fifths_at_beat(0, changes, Fraction(7)) == 0
        assert fifths_at_beat(0, changes, Fraction(8)) == -1
        assert fifths_at_beat(0, changes, Fraction(99)) == -1
