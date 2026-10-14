"""#247: chord estimation on synthesized chord AUDIO (not fake chroma).

The fake-chroma tests in test_chord.py exercise template matching and
Viterbi smoothing, but nothing covers the real path: librosa CQT over
actual audio -> per-segment chroma -> estimate. This file synthesizes
sine+harmonic chord tones and asserts the estimator names the chords
it heard - including the sus2/sus4 inversion equivalence (Csus2 and
Gsus4 share pitch classes; the bass vote + diatonic prior pick the
spelling that matches the bass).
"""

from __future__ import annotations

import numpy as np
import pytest

from hornscribe.transcription.chord import (
    diatonic_chords,
    estimate_chords,
)

_SR = 22050

# estimate_chords pulls librosa in lazily (inside _segment_chroma);
# skip the module when the analysis dependency is absent.
pytest.importorskip("librosa")


def _chord(pcs: tuple[int, ...], dur: float, root_octave: int = 4) -> np.ndarray:
    """Sine + 2 partials per tone, short linear edges."""
    t = np.linspace(0.0, dur, int(_SR * dur), endpoint=False)
    y = np.zeros_like(t)
    for pc in pcs:
        midi = 12 * root_octave + pc
        hz = 440.0 * 2 ** ((midi - 69) / 12)
        for h in range(1, 4):
            y += (0.6 ** (h - 1)) * np.sin(2 * np.pi * hz * h * t)
    edge = np.minimum(1.0, np.minimum(t, dur - t) * 50.0)
    return (y * edge).astype(np.float32)


def _run(chords: list[tuple[int, ...]], seg_dur: float = 2.0):
    y = np.concatenate([_chord(c, seg_dur) for c in chords])
    segs = tuple((i * seg_dur, (i + 1) * seg_dur) for i in range(len(chords)))
    return estimate_chords(
        y, _SR, segs, diatonic=diatonic_chords(0, "major")
    )


def _chord_over_bass(
    bass_pc: int, upper_pcs: tuple[int, ...], dur: float
) -> np.ndarray:
    """Chord voiced like a real mix: bass note in the low register,
    chord tones two octaves up. The bass-register CQT then reads the
    bass voice - what separates C6 from Am7, C from C/E."""
    t = np.linspace(0.0, dur, int(_SR * dur), endpoint=False)
    y = np.zeros_like(t)
    # Bass slightly under the chord voices, as a real mix voices it -
    # loud enough that the low-register chroma locks the bass voice,
    # quiet enough that the chord tones still own the full chroma.
    for midi, amp in [(36 + bass_pc, 0.7)] + [
        (72 + pc, 1.0) for pc in upper_pcs
    ]:
        hz = 440.0 * 2 ** ((midi - 69) / 12)
        for h in range(1, 4):
            y += amp * (0.6 ** (h - 1)) * np.sin(2 * np.pi * hz * h * t)
    edge = np.minimum(1.0, np.minimum(t, dur - t) * 50.0)
    return (y * edge).astype(np.float32)


def _run_bass(
    cases: list[tuple[int, tuple[int, ...]]], seg_dur: float = 2.0
):
    y = np.concatenate(
        [_chord_over_bass(b, p, seg_dur) for b, p in cases]
    )
    segs = tuple((i * seg_dur, (i + 1) * seg_dur) for i in range(len(cases)))
    return estimate_chords(
        y, _SR, segs, diatonic=diatonic_chords(0, "major")
    )


def test_jpop_colour_qualities_on_real_audio() -> None:
    """Cadd9 / Csus2 / C7sus4 audio resolves to its own symbol."""
    est = _run([(0, 4, 7, 2), (0, 2, 7), (0, 5, 7, 10)])
    assert [e.label() for e in est] == ["Cadd9", "Csus2", "C7sus4"]


def test_dim7_vs_dim_triad_on_real_audio() -> None:
    """#246: the diminished triad and dim7 must separate on audio too,
    not only on synthetic chroma vectors."""
    est = _run([(0, 3, 6, 9), (0, 3, 6)])
    assert [e.label() for e in est] == ["Cdim7", "Cdim"]


def test_sus2_picked_over_enharmonic_sus4_in_c_major() -> None:
    """Csus2 and Gsus4 are the same pitch classes - in C major with
    C in the bass register the read is Csus2, not Gsus4."""
    est = _run([(0, 2, 7)])
    assert est[0].root_pc == 0
    assert est[0].quality == "sus2"


def test_sixth_vs_minor_seventh_split_on_the_bass() -> None:
    """C6 and Am7 share every pitch class - only the bass voice can
    name them. A tonic-sixth ending reads as 6; the relative minor
    reads as m7. The upper voice leaves the root to the bass (a real
    voicing) so the extension tone stays audible in the chroma."""
    est = _run_bass(
        [
            (0, (4, 7, 9)),   # C bass + E G A -> C6
            (9, (0, 4, 7)),   # A bass + C E G -> Am7
        ]
    )
    assert [e.label() for e in est] == ["C6", "Am7"]


def test_minor_sixth_vs_half_diminished_split_on_the_bass() -> None:
    """Cm6 and Am7-5 are the same pitch-class set too."""
    est = _run_bass(
        [
            (0, (3, 7, 9)),   # C bass + Eb G A -> Cm6
            (9, (0, 3, 7)),   # A bass + C Eb G -> Am7-5
        ]
    )
    assert [e.label() for e in est] == ["Cm6", "Am7-5"]


def test_minor_major_seventh_on_real_audio() -> None:
    """The melodic-minor tonic colour - no enharmonic twin."""
    est = _run_bass([(0, (3, 7, 11))])
    assert est[0].label() == "CmMaj7"


def test_first_inversion_prints_the_slash() -> None:
    """C major over an E bass is C/E - the walk-up bass lines JPOP
    verses lean on."""
    est = _run_bass([(4, (0, 4, 7))])
    assert est[0].root_pc == 0
    assert est[0].bass_pc == 4
    assert est[0].label() == "C/E"


def test_root_position_never_prints_a_slash() -> None:
    """A strong root fundamental leaks harmonics onto the 5th and
    3rd - the margin gate must keep that off the label."""
    est = _run_bass([(0, (4, 7))])
    assert est[0].bass_pc is None
    assert est[0].label() == "C"
