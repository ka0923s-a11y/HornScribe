"""#419: chord-map estimation - template match + Viterbi smoothing.

The chroma extractor is monkeypatched so the estimator logic runs
without librosa; what is under test is the template match, the
fifths-distance switch cost, the diatonic prior, and the
flags-to-issue mapping in the pipeline.
"""

from __future__ import annotations

from fractions import Fraction

import numpy as np

import hornscribe.transcription.chord as chord_mod
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    ScoreRevisionId,
)
from hornscribe.domain.review import ReviewReason, Severity
from hornscribe.domain.score import Part, QuantizedNote
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.transcription.chord import (
    ChordEstimate,
    chord_label,
    diatonic_chords,
    estimate_chords,
)
from hornscribe.transcription.pipeline import (
    _chord_issues,
    _merged_chord_dicts,
)

_SR = 22050


def _template_vec(root: int, quality: str) -> np.ndarray:
    states, vecs = chord_mod._templates()
    return vecs[states.index((root, quality))]


def _fake_chroma(rows: list[np.ndarray]):
    def fake(samples, sr, segments):
        return np.array(rows)

    return fake


def _est(
    lo: float,
    hi: float,
    root: int,
    quality: str,
    confidence: float,
    margin: float,
    runner_up: str | None = None,
) -> ChordEstimate:
    return ChordEstimate(
        start_sec=lo,
        end_sec=hi,
        root_pc=root,
        quality=quality,
        confidence=confidence,
        margin=margin,
        runner_up=runner_up,
    )


def _note(n: int, pitch: int, start: str, dur: str) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId(f"sn-{n:06d}"),
        source_event_ids=(RawNoteEventId(f"rne-{n:06d}"),),
        pitch_midi=pitch,
        start_beat=Fraction(start),
        duration_beats=Fraction(dur),
    )


class TestLabels:
    def test_quality_suffixes(self) -> None:
        assert chord_label(0, "maj") == "C"
        assert chord_label(9, "min") == "Am"
        assert chord_label(7, "7") == "G7"
        assert chord_label(11, "m7b5") == "Bm7-5"
        assert chord_label(10, "maj") == "A#"
        assert chord_label(10, "maj", prefer_flats=True) == "Bb"
        assert chord_label(6, "min") == "F#m"
        assert chord_label(6, "min", prefer_flats=True) == "Gbm"

    def test_chord_tones(self) -> None:
        est = _est(0.0, 2.0, 0, "maj", 0.9, 0.5)
        assert set(est.chord_tones()) == {0, 4, 7}
        g7 = _est(0.0, 2.0, 7, "7", 0.9, 0.5)
        assert set(g7.chord_tones()) == {7, 11, 2, 5}


class TestDiatonic:
    def test_major_degrees(self) -> None:
        chords = diatonic_chords(0, "major")
        assert (0, "maj") in chords  # I
        assert (5, "maj") in chords  # IV
        assert (7, "7") in chords  # V7
        assert (9, "min") in chords  # vi
        assert (11, "m7b5") in chords  # vii half-dim
        # Tritone root is never diatonic to C major.
        assert not any(r == 6 for r, _q in chords)

    def test_minor_degrees(self) -> None:
        chords = diatonic_chords(0, "minor")  # A natural minor
        assert (9, "min") in chords  # i
        assert (0, "maj") in chords  # III
        assert (7, "7") in chords  # VII7
        assert (11, "m7b5") in chords  # ii half-dim


class TestEstimate:
    def test_empty_segments(self) -> None:
        assert estimate_chords([0.0], _SR, ()) == ()

    def test_clean_progression(self, monkeypatch) -> None:
        # C-triad chroma then G-triad chroma - the obvious I V.
        rows = [_template_vec(0, "maj"), _template_vec(7, "maj")]
        monkeypatch.setattr(
            chord_mod, "_segment_chroma", _fake_chroma(rows)
        )
        est = estimate_chords(
            [0.0],
            _SR,
            ((0.0, 2.0), (2.0, 4.0)),
            diatonic=diatonic_chords(0, "major"),
        )
        assert [e.label() for e in est] == ["C", "G"]
        assert all(e.confidence > 0.9 for e in est)

    def test_switch_cost_sticks_through_weak_evidence(
        self, monkeypatch
    ) -> None:
        # Seg1 slightly favors F over C (shared C tone makes the sims
        # nearly tied) - the fifths-distance switch cost keeps the
        # smoother call on C rather than flicker to F and back.
        c_vec = _template_vec(0, "maj")
        f_vec = _template_vec(5, "maj")
        mixed = f_vec + 0.98 * c_vec
        mixed = mixed / np.linalg.norm(mixed)
        rows = [c_vec, mixed, c_vec]
        monkeypatch.setattr(
            chord_mod, "_segment_chroma", _fake_chroma(rows)
        )
        est = estimate_chords(
            [0.0], _SR, ((0.0, 2.0), (2.0, 4.0), (4.0, 6.0))
        )
        assert [e.label() for e in est] == ["C", "C", "C"]

    def test_strong_change_switches(self, monkeypatch) -> None:
        rows = [_template_vec(0, "maj"), _template_vec(5, "maj")]
        monkeypatch.setattr(
            chord_mod, "_segment_chroma", _fake_chroma(rows)
        )
        est = estimate_chords([0.0], _SR, ((0.0, 2.0), (2.0, 4.0)))
        assert [e.label() for e in est] == ["C", "F"]

    def test_flat_spelling_in_flat_key(self, monkeypatch) -> None:
        rows = [_template_vec(10, "maj")]
        monkeypatch.setattr(
            chord_mod, "_segment_chroma", _fake_chroma(rows)
        )
        est = estimate_chords(
            [0.0], _SR, ((0.0, 2.0),), prefer_flats=True
        )
        assert est[0].label(prefer_flats=True) == "Bb"


class TestChordIssues:
    """Flags -> ReviewIssue mapping: only segments with actual note
    content become issues, and only below the confidence gates."""

    def _issues(
        self,
        chord_map: tuple[ChordEstimate, ...],
        notes: tuple[QuantizedNote, ...] = (),
    ):
        part = Part(id="part-1", name="Horn in F", notes=notes)
        return _chord_issues(
            chord_map,
            tuple(n for p in (part,) for n in p.notes),
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            prefer_flats=False,
        )

    def test_low_confidence_flags(self) -> None:
        # 120 bpm: beat b -> b*0.5 s. Note at beat 0 -> t=0.0 s in
        # the first segment.
        issues = self._issues(
            (_est(0.0, 2.0, 0, "maj", 0.3, 0.3, "F"),),
            (_note(1, 60, "0", "1"),),
        )
        assert len(issues) == 1
        issue = issues[0]
        assert issue.reason is ReviewReason.CHORD_UNCERTAIN
        assert issue.severity is Severity.INFO
        assert issue.evidence["suggestedChord"] == "C"
        assert issue.evidence["runnerUpChord"] == "F"
        assert issue.canonical_note_ids == (
            ScoreNoteId("sn-000001"),
        )

    def test_low_margin_flags(self) -> None:
        issues = self._issues(
            (_est(0.0, 2.0, 0, "maj", 0.6, 0.02, "F"),),
            (_note(1, 60, "0", "1"),),
        )
        assert len(issues) == 1

    def test_confident_segment_skipped(self) -> None:
        issues = self._issues(
            (_est(0.0, 2.0, 0, "maj", 0.9, 0.5, "F"),),
            (_note(1, 60, "0", "1"),),
        )
        assert issues == []

    def test_noteless_segment_skipped(self) -> None:
        # An interlude with muddy harmony carries no spelling or
        # rhythm decisions - the issue would be noise.
        issues = self._issues(
            (_est(0.0, 2.0, 0, "maj", 0.1, 0.01),),
            (_note(1, 60, "8", "1"),),  # note at t=4.0, outside
        )
        assert issues == []

    def test_merged_dicts(self) -> None:
        merged = _merged_chord_dicts(
            (
                _est(0.0, 2.0, 0, "maj", 0.9, 0.4),
                _est(2.0, 4.0, 0, "maj", 0.7, 0.3),
                _est(4.0, 6.0, 7, "maj", 0.8, 0.4),
            ),
            prefer_flats=False,
        )
        assert [m["label"] for m in merged] == ["C", "G"]
        assert merged[0]["endSec"] == 4.0
        # The merged confidence keeps the WEAKEST span - a smooth
        # run must not hide its least-certain segment.
        assert merged[0]["confidence"] == 0.7

