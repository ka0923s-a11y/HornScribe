"""QNT-001: QuantizationProfile / diagnostics / note contracts (design 5, 30–31, 41)."""

from __future__ import annotations

import subprocess
import sys
from dataclasses import FrozenInstanceError
from fractions import Fraction

import pytest

from hornscribe.domain.ids import RawNoteEventId, ScoreNoteId
from hornscribe.rhythm import (
    QUANTIZER_ID,
    QUANTIZER_VERSION,
    NormalizedNote,
    NotationRealization,
    QuantizationAlternative,
    QuantizationDiagnostics,
    QuantizationProfile,
    QuantizedRhythmNote,
    QuantizerWeights,
    RhythmAtom,
    TripletPolicy,
)

# --- QuantizerWeights / QuantizationProfile (design 30-31) -------------------------


def test_weights_match_design_initial_values() -> None:
    weights = QuantizerWeights()
    assert weights.onset == 4.0
    assert weights.ioi == 2.0
    assert weights.offset == 1.0
    assert weights.symbol == 0.55
    assert weights.tie == 0.45
    assert weights.first_dot == 0.08
    assert weights.second_dot == 0.35
    assert weights.tuplet_group == 1.20
    assert weights.tuplet_atom == 0.12
    assert weights.mode_switch == 0.70
    assert weights.tiny_rest == 0.75
    assert weights.weak_boundary_crossing == 0.90
    assert weights.strong_boundary_crossing == 1.40
    assert weights.weights_version == 1  # QNT-007: v1 is the frozen standard


def test_profile_defaults() -> None:
    profile = QuantizationProfile()
    assert profile.min_note_value_ql == Fraction(1, 4)  # sixteenth grid
    assert profile.triplet_policy is TripletPolicy.AUTO
    assert profile.k_best == 3  # design 19: default K = 3
    assert profile.candidate_window_ql == Fraction(7, 20)  # ~0.35 ql
    assert profile.max_alignment_shift_sec == pytest.approx(0.12)  # ±120 ms
    assert isinstance(profile.weights, QuantizerWeights)


def test_profile_presets() -> None:
    standard = QuantizationProfile.standard()
    close = QuantizationProfile.close_to_performance()
    simple = QuantizationProfile.simple()
    # 原演奏に近く: timing fidelity up, notation complexity down
    assert close.weights.onset > standard.weights.onset
    assert close.weights.symbol < standard.weights.symbol
    # 簡潔: timing tolerance up, complexity/tiny-rest penalties up
    assert simple.weights.symbol > standard.weights.symbol
    assert simple.weights.tiny_rest > standard.weights.tiny_rest
    assert simple.sigma_onset_ql > standard.sigma_onset_ql


def test_profile_validation() -> None:
    with pytest.raises(ValueError, match="k_best"):
        QuantizationProfile(k_best=0)
    with pytest.raises(ValueError, match="min_note_value_ql"):
        QuantizationProfile(min_note_value_ql=Fraction(1, 3))  # not a binary unit
    with pytest.raises(ValueError, match="sigma"):
        QuantizationProfile(sigma_onset_ql=0.0)
    with pytest.raises(TypeError, match="exact Fraction"):
        QuantizationProfile(min_note_value_ql=0.25)  # type: ignore[arg-type]


def test_profile_is_immutable() -> None:
    profile = QuantizationProfile()
    with pytest.raises(FrozenInstanceError):
        profile.k_best = 5  # type: ignore[misc]


def test_weights_reject_invalid() -> None:
    with pytest.raises(ValueError):
        QuantizerWeights(onset=-1.0)
    with pytest.raises(ValueError):
        QuantizerWeights(onset=float("nan"))


# --- NormalizedNote / QuantizedRhythmNote (design 5.4-5.5) --------------------------


def test_normalized_note() -> None:
    note = NormalizedNote(
        source_id=RawNoteEventId("rne-000001"),
        pitch_midi=60,
        onset_ql=1.0,
        offset_ql=1.5,
        confidence=0.8,
    )
    assert note.onset_ql == 1.0
    with pytest.raises(ValueError, match="finite"):
        NormalizedNote(
            source_id=RawNoteEventId("rne-000001"),
            pitch_midi=60,
            onset_ql=float("nan"),
            offset_ql=1.0,
        )


def _quantized_note(**overrides: object) -> QuantizedRhythmNote:
    kwargs = {
        "canonical_note_id": ScoreNoteId("sn-000001"),
        "source_event_ids": (RawNoteEventId("rne-000001"),),
        "onset_ql": Fraction(1, 4),
        "duration_ql": Fraction(1, 2),
    }
    kwargs.update(overrides)
    return QuantizedRhythmNote(**kwargs)  # type: ignore[arg-type]


def test_quantized_note_exact_fraction_positions() -> None:
    """Acceptance: exact Fraction positions at quantization boundaries."""
    note = _quantized_note(onset_ql=Fraction(1, 3))
    assert note.onset_ql == Fraction(1, 3)
    assert isinstance(note.onset_ql, Fraction)
    assert note.end_ql == Fraction(1, 3) + Fraction(1, 2)


def test_quantized_note_rejects_float_positions() -> None:
    with pytest.raises(TypeError, match="exact Fraction"):
        _quantized_note(onset_ql=0.25)
    with pytest.raises(TypeError, match="exact Fraction"):
        _quantized_note(duration_ql=0.5)


def test_quantized_note_rejects_bad_spans() -> None:
    with pytest.raises(ValueError, match="onset_ql"):
        _quantized_note(onset_ql=Fraction(-1))
    with pytest.raises(ValueError, match="duration_ql"):
        _quantized_note(duration_ql=Fraction(0))


def test_notation_realization_tiles_duration() -> None:
    notation = NotationRealization(
        atoms=(
            RhythmAtom(duration_ql=Fraction(1, 4), symbol="eighth", tie_to_next=True),
            RhythmAtom(duration_ql=Fraction(1, 4), symbol="eighth"),
        )
    )
    assert notation.total_ql == Fraction(1, 2)
    note = _quantized_note(notation=notation)
    assert note.notation is not None
    assert len(note.notation.atoms) == 2
    # mismatch fails clearly
    bad = NotationRealization(atoms=(RhythmAtom(Fraction(1), "quarter"),))
    with pytest.raises(ValueError, match="total"):
        _quantized_note(notation=bad)


def test_rhythm_atom_validation() -> None:
    with pytest.raises(ValueError, match="duration_ql"):
        RhythmAtom(duration_ql=Fraction(0), symbol="quarter")
    with pytest.raises(ValueError, match="dots"):
        RhythmAtom(duration_ql=Fraction(1), symbol="quarter", dots=3)
    with pytest.raises(ValueError, match="cannot tie"):
        RhythmAtom(Fraction(1, 4), "eighth", is_rest=True, tie_to_next=True)
    dotted = RhythmAtom(duration_ql=Fraction(3, 2), symbol="quarter", dots=1)
    assert dotted.dots == 1


def test_empty_realization_fails() -> None:
    with pytest.raises(ValueError, match="at least one"):
        NotationRealization(atoms=())


# --- QuantizationAlternative / QuantizationDiagnostics (design 5.6, 41) -------------


def test_alternative_rank_and_cost() -> None:
    alt = QuantizationAlternative(
        rank=1,
        total_cost=24.12,
        notes=(_quantized_note(),),
        diagnostics=QuantizationDiagnostics(path_cost=24.12),
    )
    assert alt.rank == 1
    with pytest.raises(ValueError, match="rank"):
        QuantizationAlternative(rank=0, total_cost=0.0, notes=())
    with pytest.raises(ValueError, match="total_cost"):
        QuantizationAlternative(rank=1, total_cost=float("inf"), notes=())


def test_diagnostics_defaults() -> None:
    diag = QuantizationDiagnostics()
    assert diag.quantizer_id == QUANTIZER_ID == "HSQ"
    assert diag.quantizer_version == QUANTIZER_VERSION == 4
    assert diag.symbol_count == 0
    assert diag.review_reasons == ()
    filled = QuantizationDiagnostics(
        meter="4/4",
        min_note_value_ql=Fraction(1, 4),
        triplet_policy=TripletPolicy.AUTO,
        alignment_shift_sec=0.034,
        path_cost=24.12,
        alternative_cost=24.37,
        ambiguous_region_count=2,
        symbol_count=32,
        tie_count=3,
        review_reasons=("quantization_ambiguous",),
    )
    assert filled.meter == "4/4"
    assert filled.min_note_value_ql == Fraction(1, 4)
    assert filled.review_reasons == ("quantization_ambiguous",)


# --- dependency boundary (acceptance: no audio/GUI dependency) -----------------------


def test_rhythm_imports_no_audio_or_gui_dependencies() -> None:
    """hornscribe.rhythm must stay stdlib-only (no music21/numpy/Qt)."""
    code = (
        "import sys, hornscribe.rhythm; "
        "bad = {'music21', 'numpy', 'PyQt5', 'PySide6', 'librosa'} & set(sys.modules); "
        "sys.exit(1 if bad else 0)"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
