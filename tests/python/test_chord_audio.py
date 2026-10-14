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

librosa = pytest.importorskip("librosa")

from hornscribe.transcription.chord import (
    diatonic_chords,
    estimate_chords,
)

_SR = 22050


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
