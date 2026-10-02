"""B-flat transposing-instrument written-pitch projection (#156).

A B-flat instrument sounds a major second *below* written pitch, so
the concert -> written projection is +M2 (+2 semitones)::

    Concert C4  ->  written D4
    Concert Bb3 ->  written C4
    Concert F#4 ->  written G#4

This covers the B-flat side of a double horn and the standard B-flat
treble instruments (trumpet, clarinet, tenor/soprano sax) - all share
the same written->sounding interval. MusicXML ``<transpose>``
describes the inverse direction (written -> sounding)::

    <transpose>
      <diatonic>-1</diatonic>
      <chromatic>-2</chromatic>
    </transpose>

Two-stage responsibility (mirrors :mod:`hornscribe.instruments.horn_f`):

1. canonical concert notes -> written notes (+M2, this module)
2. written notes -> MusicXML ``transpose`` metadata (-M2) in
   :mod:`hornscribe.export.musicxml`

Key signatures transpose by the same interval: written key = concert
key +2 fifths (C major -> D major, Bb major -> C major, F major ->
G major).
"""

from __future__ import annotations

from dataclasses import replace
from enum import Enum

from hornscribe.domain.score import KeySignature, Part, QuantizedNote

# --- transposition constants -------------------------------------------------

# concert -> written (domain projection direction)
B_FLAT_CONCERT_TO_WRITTEN_SEMITONES = 2

# written -> sounding (MusicXML <transpose> direction)
B_FLAT_WRITTEN_TO_SOUNDING_DIATONIC = -1
B_FLAT_WRITTEN_TO_SOUNDING_CHROMATIC = -2

# --- pitch projection ---------------------------------------------------------


def concert_to_written_midi(pitch_midi: int) -> int:
    """Project a sounding/concert MIDI pitch to written B-flat pitch (+M2)."""
    return pitch_midi + B_FLAT_CONCERT_TO_WRITTEN_SEMITONES


def written_to_concert_midi(pitch_midi: int) -> int:
    """Recover the sounding/concert MIDI pitch from a written pitch (-M2)."""
    return pitch_midi - B_FLAT_CONCERT_TO_WRITTEN_SEMITONES


# --- key signature projection -------------------------------------------------


def _fold_fifths(fifths: int) -> int:
    """Fold a fifths value into the valid [-7, +7] key-signature range.

    Adding 12 fifths respells the key enharmonically (identical sounding
    pitch collection, different printed signature). Same policy as
    horn_f._fold_fifths - kept private so each instrument module
    documents its own projection end-to-end.
    """
    folded = fifths
    while folded > 7:
        folded -= 12
    while folded < -7:
        folded += 12
    return folded


def written_fifths(concert_fifths: int) -> int:
    """Concert fifths -> written B-flat fifths (+2, enharmonically folded).

    C major (0) -> D major (+2), Bb major (-2) -> C major (0),
    F# major (+6) -> +8 folds to -4 (Ab major - same sounding pitches).
    """
    return _fold_fifths(concert_fifths + 2)


def written_key_signature(key: KeySignature) -> KeySignature:
    """Concert key signature -> written B-flat key signature (+2 fifths)."""
    return replace(key, fifths=written_fifths(key.fifths))


def concert_key_signature(key: KeySignature) -> KeySignature:
    """Written B-flat key signature -> concert key signature (-2 fifths)."""
    return replace(key, fifths=_fold_fifths(key.fifths - 2))


# --- note / part projection ----------------------------------------------------


def written_note(note: QuantizedNote) -> QuantizedNote:
    """Written-pitch view of a canonical note.

    Same canonical ID and timing; only the pitch is projected. The result is
    a presentation object, never canonical content.
    """
    return replace(note, pitch_midi=concert_to_written_midi(note.pitch_midi))


def written_part(part: Part) -> Part:
    """Written-pitch view of a canonical part (same canonical note IDs)."""
    return replace(part, notes=tuple(written_note(n) for n in part.notes))


# --- range warnings (mirrors horn_f range bands in written space) -------------


class BFlatRangeStatus(Enum):
    """Internal warning level for the written B-flat range.

    The bands are the horn_f written bands shifted DOWN by the
    projection difference (5 semitones: +2 vs +7 written), so a
    *sounding* pitch classifies identically in either view - the
    B-flat horn is the same physical instrument.
    """

    NORMAL = "normal"
    CAUTION = "caution"
    EXTREME = "extreme"


# Written-pitch thresholds (MIDI note numbers) - horn_f bands -5.
_NORMAL_LOW, _NORMAL_HIGH = 42, 81  # written F#2 .. A5
_CAUTION_LOW, _CAUTION_HIGH = 37, 86  # written C#2 .. D6


def written_range_status(written_midi: int) -> BFlatRangeStatus:
    """Classify a *written* B-flat pitch against provisional range bands."""
    if _NORMAL_LOW <= written_midi <= _NORMAL_HIGH:
        return BFlatRangeStatus.NORMAL
    if _CAUTION_LOW <= written_midi <= _CAUTION_HIGH:
        return BFlatRangeStatus.CAUTION
    return BFlatRangeStatus.EXTREME


def sounding_range_status(sounding_midi: int) -> BFlatRangeStatus:
    """Classify a *sounding/concert* pitch against the written bands.

    Equivalent to horn_f.sounding_range_status - the +2 projection
    against the -5-shifted bands yields the same sounding-pitch
    classification in either view.
    """
    return written_range_status(concert_to_written_midi(sounding_midi))
