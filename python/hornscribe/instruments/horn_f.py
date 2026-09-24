"""Horn in F written-pitch projection (ENG-001; dev plan §12).

Horn in F sounds a perfect fifth *below* written pitch, so the
concert -> written projection is +P5 (+7 semitones)::

    Concert C4  ->  Horn written G4
    Concert F#4 ->  Horn written C#5
    Concert Bb3 ->  Horn written F4

MusicXML ``<transpose>`` describes the inverse direction (written ->
sounding), which is why Horn in F MusicXML carries::

    <transpose>
      <diatonic>-4</diatonic>
      <chromatic>-7</chromatic>
    </transpose>

Two-stage responsibility (§12.3, double-transposition prevention):

1. canonical concert notes -> written notes (+P5, this module)
2. written notes -> MusicXML ``transpose`` metadata (-P5, music21
   ``instrument.Horn`` in :mod:`hornscribe.export.musicxml`)

The note pitch stored in Horn MusicXML is the *written* pitch; a reader
applies ``chromatic=-7`` to recover the canonical sounding pitch.

Key signatures transpose by the same interval: written key = concert key
+1 fifth (C major -> G major, F major -> C major, Bb major -> F major).
"""

from __future__ import annotations

from dataclasses import replace
from enum import Enum

from hornscribe.domain.score import KeySignature, Part, QuantizedNote

# --- transposition constants -------------------------------------------------

# concert -> written (domain projection direction)
HORN_F_CONCERT_TO_WRITTEN_SEMITONES = 7

# written -> sounding (MusicXML <transpose> direction)
HORN_F_WRITTEN_TO_SOUNDING_DIATONIC = -4
HORN_F_WRITTEN_TO_SOUNDING_CHROMATIC = -7

# --- pitch projection ---------------------------------------------------------


def concert_to_written_midi(pitch_midi: int) -> int:
    """Project a sounding/concert MIDI pitch to Horn in F written pitch (+P5)."""
    return pitch_midi + HORN_F_CONCERT_TO_WRITTEN_SEMITONES


def written_to_concert_midi(pitch_midi: int) -> int:
    """Recover the sounding/concert MIDI pitch from a written pitch (-P5)."""
    return pitch_midi - HORN_F_CONCERT_TO_WRITTEN_SEMITONES


# --- key signature projection -------------------------------------------------


def _fold_fifths(fifths: int) -> int:
    """Fold a fifths value into the valid [-7, +7] key-signature range.

    Adding 12 fifths respells the key enharmonically (C# major +7 <->
    Db major -5): the sounding pitch collection is identical, only the
    printed signature changes. Used when the +P5 projection would
    leave the valid range (concert +7 -> written +8 folds to -4, i.e.
    C# major sounds on Horn in F as written Ab major).
    """
    folded = fifths
    while folded > 7:
        folded -= 12
    while folded < -7:
        folded += 12
    return folded


def written_fifths(concert_fifths: int) -> int:
    """Concert fifths -> Horn in F written fifths (+1, enharmonically folded).

    The single projection policy for written-key spelling (#257): key
    signatures and note spelling must agree, so both go through this
    helper instead of a bare ``+1``.
    """
    return _fold_fifths(concert_fifths + 1)


def written_key_signature(key: KeySignature) -> KeySignature:
    """Concert key signature -> Horn in F written key signature (+1 fifth).

    C major (0) -> G major (+1), F major (-1) -> C major (0),
    Bb major (-2) -> F major (-1). Mode is preserved. A concert key
    of +7 (C# major / A# minor) projects to +8, which is not a valid
    signature — it folds enharmonically to -4 (Ab major), keeping the
    sounding pitch identical (#257).
    """
    return replace(key, fifths=written_fifths(key.fifths))


def concert_key_signature(key: KeySignature) -> KeySignature:
    """Horn in F written key signature -> concert key signature (-1 fifth)."""
    # A written key of -7 (Cb major / Ab minor) projects to -8, which
    # folds enharmonically to +4 (E major) — the inverse of the
    # written projection's fold (#257).
    return replace(key, fifths=_fold_fifths(key.fifths - 1))


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


# --- range warnings (dev plan §12.5) -------------------------------------------


class HornRangeStatus(Enum):
    """Internal warning level for Horn in F written range.

    The app never silently octave-shifts out-of-range notes; it only flags
    them. Thresholds are conservative defaults — actual playable range is a
    player-level judgement left to the user.
    """

    NORMAL = "normal"
    CAUTION = "caution"
    EXTREME = "extreme"


# Written-pitch thresholds (MIDI note numbers).
_NORMAL_LOW, _NORMAL_HIGH = 47, 86  # written B2 .. D6
_CAUTION_LOW, _CAUTION_HIGH = 42, 91  # written F#2 .. G6


def written_range_status(written_midi: int) -> HornRangeStatus:
    """Classify a *written* Horn in F pitch against provisional range bands."""
    if _NORMAL_LOW <= written_midi <= _NORMAL_HIGH:
        return HornRangeStatus.NORMAL
    if _CAUTION_LOW <= written_midi <= _CAUTION_HIGH:
        return HornRangeStatus.CAUTION
    return HornRangeStatus.EXTREME


def sounding_range_status(sounding_midi: int) -> HornRangeStatus:
    """Classify a *sounding/concert* pitch against Horn in F range bands."""
    return written_range_status(concert_to_written_midi(sounding_midi))
