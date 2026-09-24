"""Key-aware enharmonic spelling for MusicXML output (#165).

music21.pitch.Pitch(midi=...) picks a fixed default name (C#, Eb, F#,
G#, Bb, ...) that ignores the key signature, so a flat-key piece gets
sharp spellings on every chromatic note. This module chooses the
spelling whose position on the circle of fifths sits closest to the
key diatonic block.

Every pitch class has the spellings whose alteration fits a single
sharp or flat (|alter| <= 1): the diatonic one when the pitch class is
in the key, otherwise the sharp-of-below / flat-of-above pair. The
diatonic block of a key at fifths spans [fifths-1, fifths+5] on the
circle. The winning spelling is nearest to that block; ties break
toward the key own accidental direction (flat keys prefer flats).

is_diatonic flags pitch classes outside the key — the notes whose
spelling is genuinely ambiguous and worth a pitch_spelling_ambiguous
review issue (#166).
"""

from __future__ import annotations

from fractions import Fraction

from hornscribe.domain.score import KeyChange

# Natural pitch class per letter (C=0) and each letter position on the
# circle of fifths (C=0, G=1, D=2, A=3, E=4, B=5, F=-1).
_NAT_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NAT_FIFTHS = {"C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F": -1}


def _candidates(pc: int) -> list[tuple[str, int, int]]:
    """(letter, alter, fifths_position) spellings with |alter| <= 1."""
    out: list[tuple[str, int, int]] = []
    for letter, nat_pc in _NAT_PC.items():
        alter = (pc - nat_pc) % 12
        if alter > 6:
            alter -= 12
        if abs(alter) > 1:
            continue
        fifths_pos = _NAT_FIFTHS[letter] + 7 * alter
        out.append((letter, alter, fifths_pos))
    return out


def _block(fifths: int) -> tuple[int, int]:
    """Diatonic fifths range [fifths-1, fifths+5] for the key."""
    return fifths - 1, fifths + 5


def _distance(pos: int, lo: int, hi: int) -> int:
    if lo <= pos <= hi:
        return 0
    return min(abs(pos - lo), abs(pos - hi))


def _best(pc: int, fifths: int) -> tuple[str, int, int]:
    lo, hi = _block(fifths)
    cands = _candidates(pc)
    prefer_sharp = fifths >= 0

    def key(c: tuple[str, int, int]) -> tuple[int, int, int]:
        _letter, alter, pos = c
        dist = _distance(pos, lo, hi)
        # Tie-break: flat keys prefer the flat-side (lower fifths)
        # candidate, sharp keys the sharp-side (higher fifths).
        side = -pos if prefer_sharp else pos
        return (dist, side, abs(alter))

    return min(cands, key=key)


def spell_midi(pitch_midi: int, fifths: int) -> tuple[str, int, int]:
    """Key-aware (letter, alter, octave) for a sounding/written pitch.

    fifths is the active key signature fifths in the SAME presentation
    the pitch lives in (concert key for concert pitch, written key for
    written horn pitch — the caller transposes both).
    """
    pc = pitch_midi % 12
    letter, alter, _pos = _best(pc, fifths)
    nat_pc = _NAT_PC[letter]
    octave = (pitch_midi - nat_pc - alter) // 12 - 1
    return letter, alter, octave


def spell_name(pitch_midi: int, fifths: int) -> str:
    """music21-style name (F#4, G-3, C5) for the key-aware spelling."""
    letter, alter, octave = spell_midi(pitch_midi, fifths)
    acc = "#" if alter > 0 else ("-" if alter < 0 else "")
    return f"{letter}{acc}{octave}"


def is_diatonic(pitch_midi: int, fifths: int) -> bool:
    """True when the pitch class is diatonic to the key (unambiguous);
    False for chromatic notes worth a spelling review."""
    pc = pitch_midi % 12
    _letter, _alter, pos = _best(pc, fifths)
    lo, hi = _block(fifths)
    return lo <= pos <= hi


def fifths_at_beat(
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    beat: Fraction,
) -> int:
    """Active key-signature fifths at beat on the canonical axis.

    With no key map the head signature governs the whole piece;
    otherwise the latest change at or before beat wins (the first
    change sits at beat 0 by contract, so active is always set).
    """
    if not key_changes:
        return head_fifths
    active = key_changes[0].key_signature.fifths
    for change in key_changes:
        if change.start_beat <= beat:
            active = change.key_signature.fifths
        else:
            break
    return int(active)
