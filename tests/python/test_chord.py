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


def _fake_chroma(
    rows: list[np.ndarray],
    bass_rows: list[np.ndarray] | None = None,
):
    def fake(samples, sr, segments):
        bass = (
            np.array(bass_rows)
            if bass_rows is not None
            else np.zeros((len(rows), 12))
        )
        return np.array(rows), bass

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
        # #272: harmonic-minor dominants - V7 (E7) and vii dim7
        # (G#dim7) are where a minor-key song cadences, so the prior
        # must not treat them as chromatic while v (Em) gets the nod.
        assert (4, "7") in chords  # V7
        assert (8, "dim7") in chords  # vii dim7
        assert (4, "min") in chords  # v keeps its modal seat


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
        # Seg2 mixes F over C. Since #247's colour templates exist,
        # that mixture's honest read is C6 (it literally contains C,E,
        # G,A) - and the interesting part: Am7 shares every pitch
        # class AND scores higher raw similarity, but switching
        # C -> Am7 costs a 3-step fifths move while C -> C6 is a
        # same-root half-price hop. The smoother routes through the
        # same-root colour, which is the musically right answer for
        # a passing-tone smear inside a I-major region.
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
        assert [e.label() for e in est] == ["C", "C6", "C"]
        # The root never flickered cross-fifths - the read stayed
        # inside the tonic region throughout.
        assert [e.root_pc for e in est] == [0, 0, 0]

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

    def test_dim_triad_and_dim7_are_distinct(self, monkeypatch) -> None:
        """#246: the diminished triad reports 'dim'; the same tones
        plus the diminished seventh report 'dim7' - the old single
        'dim' template was a dim7 shape, so a real dim7 exported as a
        diminished triad."""
        dim7_chroma = np.zeros(12)
        for pc in (0, 3, 6, 9):
            dim7_chroma[pc] = 1.0
        dim7_chroma /= np.linalg.norm(dim7_chroma)
        dim_triad = np.zeros(12)
        for pc in (0, 3, 6):
            dim_triad[pc] = 1.0
        dim_triad /= np.linalg.norm(dim_triad)
        monkeypatch.setattr(
            chord_mod,
            "_segment_chroma",
            _fake_chroma([dim7_chroma, dim_triad]),
        )
        est = estimate_chords(
            [0.0], _SR, ((0.0, 2.0), (2.0, 4.0))
        )
        assert [e.label() for e in est] == ["Cdim7", "Cdim"]

    def test_jpop_colour_qualities_resolve(self, monkeypatch) -> None:
        """#247: sus2 / add9 / 7sus4 chroma each resolves to its own
        label — the colour voicings JPOP actually uses."""
        def chroma(*pcs: int) -> np.ndarray:
            v = np.zeros(12)
            for pc in pcs:
                v[pc] = 1.0
            return v / np.linalg.norm(v)

        rows = [
            chroma(0, 2, 7),        # Csus2
            chroma(0, 2, 4, 7),     # Cadd9
            chroma(0, 5, 7, 10),    # C7sus4
        ]
        monkeypatch.setattr(
            chord_mod, "_segment_chroma", _fake_chroma(rows)
        )
        est = estimate_chords(
            [0.0], _SR, ((0.0, 2.0), (2.0, 4.0), (4.0, 6.0))
        )
        assert [e.label() for e in est] == ["Csus2", "Cadd9", "C7sus4"]

    def test_sixth_spelling_follows_the_bass(self, monkeypatch) -> None:
        """#247: C6 and Am7 are the same pitch classes - identical
        full chroma - so the bass register decides the spelling."""

        def chroma(*pcs: int) -> np.ndarray:
            v = np.zeros(12)
            for pc in pcs:
                v[pc] = 1.0
            return v / np.linalg.norm(v)

        def bass(pc: int) -> np.ndarray:
            v = np.full(12, 0.05)
            v[pc] = 0.9
            return v / np.linalg.norm(v)

        monkeypatch.setattr(
            chord_mod,
            "_segment_chroma",
            _fake_chroma(
                [chroma(0, 4, 7, 9), chroma(0, 4, 7, 9)],
                [bass(0), bass(9)],
            ),
        )
        est = estimate_chords(
            [0.0], _SR, ((0.0, 2.0), (2.0, 4.0))
        )
        assert [e.label() for e in est] == ["C6", "Am7"]

    def test_inversion_names_the_bass_voice(self, monkeypatch) -> None:
        """A chord tone other than the root dominating the bass
        register prints the slash - C/E."""

        def bass(pc: int) -> np.ndarray:
            v = np.full(12, 0.05)
            v[pc] = 0.9
            return v / np.linalg.norm(v)

        monkeypatch.setattr(
            chord_mod,
            "_segment_chroma",
            _fake_chroma([_template_vec(0, "maj")], [bass(4)]),
        )
        (est,) = estimate_chords([0.0], _SR, ((0.0, 2.0),))
        assert est.root_pc == 0
        assert est.bass_pc == 4
        assert est.label() == "C/E"
        assert est.label(prefer_flats=True) == "C/E"

    def test_weak_bass_stays_root_position(self, monkeypatch) -> None:
        """Diffuse bass (under the floor) must not fabricate a slash
        - the margin also keeps a root's own harmonics from printing
        "C/G" over root position."""
        root_heavy = np.full(12, 0.28)
        root_heavy[0] = 0.6  # strong root, harmonics spread thin
        root_heavy[7] = 0.3  # 3rd-harmonic leakage below the margin
        monkeypatch.setattr(
            chord_mod,
            "_segment_chroma",
            _fake_chroma(
                [_template_vec(0, "maj")], [root_heavy]
            ),
        )
        (est,) = estimate_chords([0.0], _SR, ((0.0, 2.0),))
        assert est.bass_pc is None
        assert est.label() == "C"


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

    def test_merged_dicts_keep_slash_moves(self) -> None:
        # #272: C -> C/E is a bass walk, not a repeat - the merged
        # progression must keep the inversion or the walk-up read
        # collapses to "C | F".
        merged = _merged_chord_dicts(
            (
                _est(0.0, 2.0, 0, "maj", 0.9, 0.4),
                ChordEstimate(
                    start_sec=2.0,
                    end_sec=4.0,
                    root_pc=0,
                    quality="maj",
                    confidence=0.9,
                    margin=0.4,
                    bass_pc=4,
                ),
                _est(4.0, 6.0, 5, "maj", 0.9, 0.4),
            ),
            prefer_flats=False,
        )
        assert [m["label"] for m in merged] == ["C", "C/E", "F"]
