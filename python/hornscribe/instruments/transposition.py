"""Written-pitch transposition specs — one lookup per PitchSpace (#156).

Notation and export code used to branch on ``PitchSpace.WRITTEN_HORN_F``
directly; adding a second written view (B-flat) turned that into a
scatter of near-identical conditionals that could drift apart. Every
non-concert presentation now resolves through :func:`spec_for`, so the
projection (semitones), the MusicXML ``<transpose>`` declaration and
the key-signature fifths shift can never disagree about which interval
a view uses.

``spec_for(PitchSpace.CONCERT)`` returns ``None`` — callers write a
single ``spec is not None`` check and the identity path falls through.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from hornscribe.domain.score import KeySignature, PitchSpace
from hornscribe.instruments import b_flat, horn_f


@dataclass(frozen=True)
class TranspositionSpec:
    """One written-pitch projection rule.

    ``concert_to_written_semitones`` shifts canonical pitches into the
    written space; ``written_to_sounding_*`` is the MusicXML
    ``<transpose>`` declaration (inverse direction); ``fifths_shift``
    moves a concert key signature into the written signature.
    """

    concert_to_written_semitones: int
    written_to_sounding_diatonic: int
    written_to_sounding_chromatic: int
    fifths_shift: int
    # Printed staff label for the written view: canonical part names
    # anchored on the F-horn label get re-anchored on the view's own
    # transposition, so a printed Bb part never reads Horn in F.
    # None keeps the domain part name verbatim.
    display_instrument: str | None


# Single source of truth: the interval numbers live in the per-instrument
# modules (horn_f / b_flat); this table only binds them to PitchSpace.
_SPECS: dict[PitchSpace, TranspositionSpec] = {
    PitchSpace.WRITTEN_HORN_F: TranspositionSpec(
        concert_to_written_semitones=horn_f.HORN_F_CONCERT_TO_WRITTEN_SEMITONES,
        written_to_sounding_diatonic=horn_f.HORN_F_WRITTEN_TO_SOUNDING_DIATONIC,
        written_to_sounding_chromatic=horn_f.HORN_F_WRITTEN_TO_SOUNDING_CHROMATIC,
        fifths_shift=1,
        display_instrument=None,
    ),
    PitchSpace.WRITTEN_B_FLAT: TranspositionSpec(
        concert_to_written_semitones=b_flat.B_FLAT_CONCERT_TO_WRITTEN_SEMITONES,
        written_to_sounding_diatonic=b_flat.B_FLAT_WRITTEN_TO_SOUNDING_DIATONIC,
        written_to_sounding_chromatic=b_flat.B_FLAT_WRITTEN_TO_SOUNDING_CHROMATIC,
        fifths_shift=2,
        display_instrument='Horn in B\u266d',
    ),
}


def spec_for(space: PitchSpace) -> TranspositionSpec | None:
    """The projection rule for *space*, or ``None`` for CONCERT."""
    return _SPECS.get(space)


def _fold_fifths(fifths: int) -> int:
    """Fold a fifths count into the valid [-7, +7] signature range."""
    folded = fifths
    while folded > 7:
        folded -= 12
    while folded < -7:
        folded += 12
    return folded


def concert_to_written_midi(pitch_midi: int, space: PitchSpace) -> int:
    """Concert MIDI -> written MIDI for *space* (identity for CONCERT)."""
    spec = spec_for(space)
    return pitch_midi + (spec.concert_to_written_semitones if spec else 0)


def written_fifths(concert_fifths: int, space: PitchSpace) -> int:
    """Concert fifths -> written fifths for *space* (identity for CONCERT)."""
    spec = spec_for(space)
    if spec is None:
        return concert_fifths
    return _fold_fifths(concert_fifths + spec.fifths_shift)


def written_key_signature(key: KeySignature, space: PitchSpace) -> KeySignature:
    """Concert key signature -> written key signature for *space*."""
    spec = spec_for(space)
    if spec is None:
        return key
    return replace(key, fifths=written_fifths(key.fifths, space))


_HORN_F_LABEL = 'Horn in F'


def display_part_name(name: str, space: PitchSpace) -> str:
    """Presentation part label for *space*.

    Domain part names describe the sounding instrument ("Horn in F",
    "Horn in F (2nd voice)"). A written view re-anchors that label on
    its own transposition ("Horn in B\u266d", "Horn in B\u266d (2nd
    voice)") so a printed part never names a different transposition
    than its ``<transpose>`` element declares. Names not anchored on
    the F-horn label pass through verbatim, as does every name in
    CONCERT space.
    """
    spec = spec_for(space)
    if spec is None or spec.display_instrument is None:
        return name
    if name == _HORN_F_LABEL:
        return spec.display_instrument
    if name.startswith(_HORN_F_LABEL + ' '):
        return spec.display_instrument + name[len(_HORN_F_LABEL):]
    return name
