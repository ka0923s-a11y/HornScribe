"""#423: boundary re-scoring expert — numpy-only onset/RMS envelopes.

Synthetic mono signals exercise each defect class: a held tone the
backend split in two (``merge``), a re-articulation hidden inside
one event (``split``), a hairline edge with no attack (``uncertain``)
— plus the suppression paths (silence/re-attack at the edge, f0 jump,
vibrato damp, short span) and the pipeline mapping onto canonical
notes via ``_boundary_issues``.
"""

from __future__ import annotations

from fractions import Fraction

import numpy as np
import pytest

from hornscribe.domain.events import PitchBendPoint, RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    ScoreRevisionId,
    TranscriptionRevisionId,
)
from hornscribe.domain.review import (
    IssueStatus,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.domain.score import (
    KeySignature,
    Part,
    QuantizedNote,
    ScoreRevisionPayload,
    TempoSegment,
    TimeSignature,
)
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.transcription.boundary import (
    OCTAVE_SNAP_ENERGY_RATIO,
    BoundaryFlag,
    boundary_flags,
    compute_envelopes,
    low_octave_evidence,
    low_octave_suspected,
    octave_band_ratio,
    octave_prefers,
    seam_evidence,
)
from hornscribe.transcription.clean import CleanedEvents
from hornscribe.transcription.pipeline import (
    _auto_pitch_fixes,
    _boundary_issues,
    _octave_dip_suspects,
    _octave_issues,
    _pitch_dip_issues,
    _pitch_fixed_payload,
    _pitch_suspect_issues,
    _PitchSuspect,
)

_SR = 22050
_REV = TranscriptionRevisionId("tr-boundary")


def _tone(
    dur: float, freq: float, amp: float = 0.5, t0: float = 0.0
) -> np.ndarray:
    n = int(round(dur * _SR))
    t = t0 + np.arange(n) / _SR
    return amp * np.sin(2.0 * np.pi * freq * t)


def _silence(dur: float) -> np.ndarray:
    return np.zeros(int(round(dur * _SR)))


def _ev(
    i: int,
    pitch: float,
    onset: float,
    offset: float,
    bends: tuple[PitchBendPoint, ...] = (),
) -> RawNoteEvent:
    return RawNoteEvent(
        id=RawNoteEventId(f"rne-{i:06d}"),
        transcription_revision=_REV,
        pitch_midi=pitch,
        onset_sec=onset,
        offset_sec=offset,
        confidence=0.9,
        source="test",
        pitch_bends=bends,
    )


def _held_tone() -> np.ndarray:
    """One continuous 440 Hz note, 0-2 s."""
    return _tone(2.0, 440.0)


def _retaken_tone() -> np.ndarray:
    """440 Hz for 1 s, then 660 Hz for 1 s — a clean interior attack
    at t=1.0 that a written single note hides."""
    return np.concatenate([_tone(1.0, 440.0), _tone(1.0, 660.0, t0=1.0)])


class TestMergeFlags:
    def test_held_tone_split_by_backend(self) -> None:
        # Two contiguous same-pitch events over one unbroken tone —
        # the backend invented a boundary the audio never made.
        flags = boundary_flags(
            _held_tone(), _SR, (_ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 2.0))
        )
        kinds = [f.kind for f in flags]
        assert "merge" in kinds
        flag = flags[kinds.index("merge")]
        assert flag.boundary_sec == pytest.approx(1.0, abs=0.05)
        assert flag.event_ids == (str(RawNoteEventId("rne-000001")),
                                str(RawNoteEventId("rne-000002")))
        assert flag.score > 0.5

    def test_silence_or_rise_suppresses_merge(self) -> None:
        # A real gap at the shared edge (silence then a faded re-entry)
        # is a legitimate boundary — no merge suggestion.
        ramp = np.linspace(0.0, 0.5, int(0.5 * _SR)) * np.sin(
            2 * np.pi * 440 * (1.1 + np.arange(int(0.5 * _SR)) / _SR)
        )
        sig = np.concatenate(
            [_tone(1.0, 440.0), _silence(0.1), ramp, _tone(0.5, 440.0, t0=1.6)]
        )
        flags = boundary_flags(
            sig, _SR, (_ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.1, 2.1))
        )
        assert "merge" not in [f.kind for f in flags]

    def test_pitch_change_edge_is_not_a_merge(self) -> None:
        flags = boundary_flags(
            _held_tone(), _SR, (_ev(1, 60, 0.0, 1.0), _ev(2, 62, 1.0, 2.0))
        )
        assert "merge" not in [f.kind for f in flags]

    def test_f0_jump_suppresses_merge(self) -> None:
        # Written pitches tie but the tracked contour climbed a whole
        # semitone into the edge — the line actually moved.
        a = _ev(
            1, 60, 0.0, 1.0,
            (PitchBendPoint(0.9, 0.0), PitchBendPoint(1.0, 1.0)),
        )
        b = _ev(
            2, 60, 1.0, 2.0,
            (PitchBendPoint(1.0, 0.0), PitchBendPoint(1.9, 0.0)),
        )
        flags = boundary_flags(_held_tone(), _SR, (a, b))
        assert "merge" not in [f.kind for f in flags]


class TestSeamEvidence:
    """seam_evidence — the merge flag's rule table, exported so the
    cleaner can arbitrate BEFORE stitching a seam away."""

    def test_attack_at_same_pitch_seam_separates(self) -> None:
        # 440 Hz, a 30 ms dip, then a hard re-attack at t=1.0 — a
        # tongued repeat reads as separated even with no written gap.
        dip = _tone(0.03, 440.0, amp=0.05, t0=0.97)
        sig = np.concatenate(
            [_tone(0.97, 440.0), dip, _tone(1.0, 440.0, t0=1.0)]
        )
        env = compute_envelopes(sig, _SR)
        seam = seam_evidence(
            _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 2.0), env
        )
        assert seam.separated
        assert seam.onset_peak >= 0.30

    def test_release_edge_is_not_an_attack(self) -> None:
        # The seam sits ON the predecessor's release: a broadband click
        # spikes the flux, but energy collapses right after — the
        # sustain check keeps it a merge (rubato-4-4 tail fragment).
        rng = np.random.RandomState(0)
        click = 0.4 * rng.uniform(-1.0, 1.0, int(0.03 * _SR))
        sig = np.concatenate([_tone(1.0, 440.0), click, _silence(0.6)])
        env = compute_envelopes(sig, _SR)
        seam = seam_evidence(
            _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 1.08), env
        )
        # The click may spike the flux leg — the sustain leg must be
        # what vetoes separation, so assert the peak was high enough
        # to need it.
        assert seam.onset_peak >= 0.30
        assert not seam.separated

    def test_silence_trough_separates(self) -> None:
        sig = np.concatenate(
            [
                _tone(1.0, 440.0),
                _silence(0.05),
                _tone(1.0, 440.0, t0=1.05),
            ]
        )
        env = compute_envelopes(sig, _SR)
        seam = seam_evidence(
            _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.05, 2.05), env
        )
        assert seam.separated
        assert seam.gap_sec == pytest.approx(0.05, abs=1e-6)

    def test_unbroken_tone_does_not_separate(self) -> None:
        env = compute_envelopes(_held_tone(), _SR)
        seam = seam_evidence(
            _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 2.0), env
        )
        assert not seam.separated


class TestSplitFlags:
    def test_interior_onset_flags_split(self) -> None:
        # One written event over a clear t=1.0 re-articulation.
        flags = boundary_flags(_retaken_tone(), _SR, (_ev(1, 60, 0.0, 2.0),))
        kinds = [f.kind for f in flags]
        assert "split" in kinds
        flag = flags[kinds.index("split")]
        assert flag.boundary_sec == pytest.approx(1.0, abs=0.05)
        assert flag.detail["vibratoDamped"] is False
        assert flag.score > 0.5

    def test_sustained_note_no_split(self) -> None:
        flags = boundary_flags(_held_tone(), _SR, (_ev(1, 60, 0.0, 2.0),))
        assert [f.kind for f in flags] == []

    def test_short_event_skipped(self) -> None:
        # A 0.3 s event cannot hold a believable interior onset —
        # the span floor keeps grace-note-length events out.
        sig = np.concatenate(
            [_tone(0.15, 440.0), _tone(0.15, 660.0, t0=0.15)]
        )
        flags = boundary_flags(sig, _SR, (_ev(1, 60, 0.0, 0.3),))
        assert "split" not in [f.kind for f in flags]

    def test_vibrato_extremum_damps_split(self) -> None:
        # Same interior onset, but the bend contour peaks AT the
        # candidate — a vibrato accent, not a re-articulation.
        vib = (
            PitchBendPoint(0.8, 0.0),
            PitchBendPoint(0.9, -0.25),
            PitchBendPoint(1.0, 0.25),
            PitchBendPoint(1.1, 0.0),
        )
        flags = boundary_flags(
            _retaken_tone(), _SR, (_ev(1, 60, 0.0, 2.0, vib),)
        )
        kinds = [f.kind for f in flags]
        assert "split" in kinds
        flag = flags[kinds.index("split")]
        assert flag.detail["vibratoDamped"] is True
        assert flag.score < 0.7  # damped from the undamped ~1.0


class TestUncertainFlags:
    def test_weak_pitch_change_edge(self) -> None:
        # Contiguous different-pitch events over an unbroken tone —
        # legato is legitimate but the edge has no attack behind it.
        flags = boundary_flags(
            _held_tone(), _SR, (_ev(1, 60, 0.0, 1.0), _ev(2, 61, 1.0, 2.0))
        )
        kinds = [f.kind for f in flags]
        assert "uncertain" in kinds

    def test_gapped_edge_not_uncertain(self) -> None:
        # A 0.2 s silence is a real separation — nothing to ask about.
        sig = np.concatenate(
            [_tone(1.0, 440.0), _silence(0.2), _tone(1.0, 494.0, t0=1.2)]
        )
        flags = boundary_flags(
            sig, _SR, (_ev(1, 60, 0.0, 1.0), _ev(2, 62, 1.2, 2.2))
        )
        assert flags == ()


class TestOffset:
    def test_flags_return_absolute_seconds(self) -> None:
        # Selection jobs analyse a slice: event times stay absolute,
        # the samples clock starts at time_offset_sec.
        flags = boundary_flags(
            _held_tone(),
            _SR,
            (_ev(1, 60, 5.0, 6.0), _ev(2, 60, 6.0, 7.0)),
            time_offset_sec=5.0,
        )
        kinds = [f.kind for f in flags]
        assert "merge" in kinds
        flag = flags[kinds.index("merge")]
        assert flag.boundary_sec == pytest.approx(6.0, abs=0.05)


def _note(
    n: int, pitch: int, start: str, dur: str, event_ids: tuple
) -> QuantizedNote:
    return QuantizedNote(
        id=ScoreNoteId(f"sn-{n:06d}"),
        source_event_ids=event_ids,
        pitch_midi=pitch,
        start_beat=Fraction(start),
        duration_beats=Fraction(dur),
    )


def _cleaned(*events: RawNoteEvent) -> CleanedEvents:
    return CleanedEvents(
        events=tuple(events),
        dropped_too_short=0,
        merged=0,
        clipped_overlaps=0,
    )


class TestBoundaryIssues:
    """Flags -> ReviewIssue mapping: only edges whose suggested fix
    can actually apply on the canonical score become issues."""

    def test_merge_issue(self) -> None:
        a, b = _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 2.0)
        # 120 bpm fixed warp: 1.0 s = 2 ql = 2 beats in 4/4.
        n1 = _note(1, 60, "0", "2", (a.id,))
        n2 = _note(2, 60, "2", "2", (b.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n1, n2))
        issues = _boundary_issues(
            _held_tone(),
            _SR,
            (_cleaned(a, b),),
            (part,),
            {a.id: a, b.id: b},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        merges = [
            i for i in issues
            if i.evidence.get("suggestedKind") == "merge"
        ]
        assert len(merges) == 1
        issue = merges[0]
        assert issue.reason is ReviewReason.BOUNDARY_UNCERTAIN
        assert issue.severity is Severity.CAUTION
        assert issue.canonical_note_ids == (n1.id, n2.id)
        assert issue.evidence["boundarySec"] == pytest.approx(1.0, abs=0.05)

    def test_merge_dropped_when_not_adjacent(self) -> None:
        # Same flag, but the canonical notes are no longer exactly
        # adjacent — the one-click merge could not apply, so no issue.
        a, b = _ev(1, 60, 0.0, 1.0), _ev(2, 60, 1.0, 2.0)
        n1 = _note(1, 60, "0", "2", (a.id,))
        n2 = _note(2, 60, "5/2", "2", (b.id,))  # beat gap between them
        part = Part(id="part-1", name="Horn in F", notes=(n1, n2))
        issues = _boundary_issues(
            _held_tone(),
            _SR,
            (_cleaned(a, b),),
            (part,),
            {a.id: a, b.id: b},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        assert [
            i for i in issues
            if i.evidence.get("suggestedKind") == "merge"
        ] == []

    def test_split_issue_carries_beat(self) -> None:
        e = _ev(1, 60, 0.0, 2.0)
        n = _note(1, 60, "0", "4", (e.id,))  # beats 0-4 covers 0-2 s
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        issues = _boundary_issues(
            _retaken_tone(),
            _SR,
            (_cleaned(e),),
            (part,),
            {e.id: e},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        splits = [
            i for i in issues
            if i.evidence.get("suggestedKind") == "split"
        ]
        assert len(splits) == 1
        issue = splits[0]
        assert issue.severity is Severity.CAUTION
        assert issue.canonical_note_ids == (n.id,)
        # boundary ~1.0 s -> ql 2 -> beat 2 at 120 bpm in 4/4.
        split_beat = Fraction(issue.evidence["suggestedSplitBeat"])
        assert n.start_beat < split_beat < n.end_beat

    def test_split_dropped_outside_span(self) -> None:
        # Same interior onset, but the canonical note only covers
        # beats 0-1 (the quantized span ended before the onset) —
        # no split can land there.
        e = _ev(1, 60, 0.0, 2.0)
        n = _note(1, 60, "0", "1", (e.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        issues = _boundary_issues(
            _retaken_tone(),
            _SR,
            (_cleaned(e),),
            (part,),
            {e.id: e},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        assert [
            i for i in issues
            if i.evidence.get("suggestedKind") == "split"
        ] == []

    def test_split_flag_snapped_off_note_edge_is_dropped(
        self, monkeypatch
    ) -> None:
        # #339: a heard onset at beat 0.1 of a beat-0-anchored note
        # snaps onto the note's own start edge on the 16th grid —
        # splitNote would fail at apply time, so the issue must not
        # be emitted at all (the fix contract: only applicable
        # remedies become issues).
        e = _ev(1, 60, 0.0, 2.0)
        n = _note(1, 60, "0", "1", (e.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        flag = BoundaryFlag(
            kind="split",
            event_ids=(str(e.id),),
            boundary_sec=0.05,  # 120bpm -> ql 0.1 -> beat 0.1
            score=0.8,
        )
        monkeypatch.setattr(
            "hornscribe.transcription.pipeline.boundary_flags",
            lambda *a, **k: [flag],
        )
        issues = _boundary_issues(
            _held_tone(),
            _SR,
            (_cleaned(e),),
            (part,),
            {e.id: e},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        assert issues == []

    def test_split_issue_reports_the_snapped_position(
        self, monkeypatch
    ) -> None:
        # #339: suggestedSplitBeat must be the position splitNote
        # will actually apply (grid-snapped), not the raw heard
        # onset fraction.
        e = _ev(1, 60, 0.0, 2.0)
        n = _note(1, 60, "0", "1", (e.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        flag = BoundaryFlag(
            kind="split",
            event_ids=(str(e.id),),
            boundary_sec=0.15,  # 120bpm -> ql 0.3 -> beat 0.3
            score=0.8,
        )
        monkeypatch.setattr(
            "hornscribe.transcription.pipeline.boundary_flags",
            lambda *a, **k: [flag],
        )
        issues = _boundary_issues(
            _held_tone(),
            _SR,
            (_cleaned(e),),
            (part,),
            {e.id: e},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        splits = [
            i for i in issues
            if i.evidence.get("suggestedKind") == "split"
        ]
        assert len(splits) == 1
        # 0.3 beats snaps to the 16th grid -> 1/4.
        assert Fraction(splits[0].evidence["suggestedSplitBeat"]) == Fraction(1, 4)

    def test_uncertain_is_info(self) -> None:
        a, b = _ev(1, 60, 0.0, 1.0), _ev(2, 61, 1.0, 2.0)
        n1 = _note(1, 60, "0", "2", (a.id,))
        n2 = _note(2, 61, "2", "2", (b.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n1, n2))
        issues = _boundary_issues(
            _held_tone(),
            _SR,
            (_cleaned(a, b),),
            (part,),
            {a.id: a, b.id: b},
            TimeWarp.fixed_bpm(120.0),
            Fraction(1),
            ScoreRevisionId("rev-test"),
            0.0,
            QuantizationProfile.standard(),
        )
        unc = [
            i for i in issues
            if i.evidence.get("suggestedKind") == "uncertain"
        ]
        assert len(unc) == 1
        assert unc[0].severity is Severity.INFO


class TestOctavePrefers:
    """The octave-flicker verdict reads the note's own spectrum.

    A real low note puts its fundamental in the target band; a real
    high note leaves the low band empty — the snap fires only when
    the target clearly dominates (x2.5), so ambiguous evidence keeps
    the detected pitch.
    """

    def test_flicker_snaps_when_target_dominates(self) -> None:
        # Truth is C4 (261.63 Hz) but the tracker reported C5 — the
        # low band dominates, so the snap to 60 is confirmed.
        sig = _tone(0.5, 261.63)
        assert octave_prefers(
            sig, _SR, 0.0, 0.5, detected_midi=72.0, target_midi=60.0
        )

    def test_real_high_note_vetoes_snap(self) -> None:
        # Truth really is C5: the C4 band carries nothing, so the
        # proposed snap is rejected and the leap survives.
        sig = _tone(0.5, 523.25)
        assert not octave_prefers(
            sig, _SR, 0.0, 0.5, detected_midi=72.0, target_midi=60.0
        )

    def test_low_note_second_harmonic_does_not_self_snap(self) -> None:
        # A true C4's 2nd harmonic lands ON the C5 band — but the
        # detected-band dominance still wins, so no upward snap.
        sig = _tone(0.5, 261.63) + 0.3 * _tone(0.5, 523.25)
        assert not octave_prefers(
            sig, _SR, 0.0, 0.5, detected_midi=60.0, target_midi=72.0
        )

    def test_short_span_abstains(self) -> None:
        # Under ~120 ms the FFT cannot resolve the fundamental —
        # abstain rather than guess from a wide smear.
        sig = _tone(0.08, 261.63)
        assert not octave_prefers(
            sig, _SR, 0.0, 0.08, detected_midi=72.0, target_midi=60.0
        )

    def test_band_ratio_target_dominant(self) -> None:
        # #361: the raw ratio quantifies the verdict the bool flattens.
        sig = _tone(0.5, 261.63)
        r = octave_band_ratio(
            sig, _SR, 0.0, 0.5, detected_midi=72.0, target_midi=60.0
        )
        assert r is not None and r > OCTAVE_SNAP_ENERGY_RATIO

    def test_band_ratio_detected_dominant(self) -> None:
        # A real C5 leaves the C4 band empty — the ratio lands on the
        # detected side, distinguishable from a genuinely tied read.
        sig = _tone(0.5, 523.25)
        r = octave_band_ratio(
            sig, _SR, 0.0, 0.5, detected_midi=72.0, target_midi=60.0
        )
        assert r is not None and r < 1.0 / OCTAVE_SNAP_ENERGY_RATIO

    def test_band_ratio_short_span_abstains(self) -> None:
        sig = _tone(0.08, 261.63)
        assert (
            octave_band_ratio(
                sig, _SR, 0.0, 0.08, detected_midi=72.0, target_midi=60.0
            )
            is None
        )

    def test_band_ratio_consistent_with_prefers(self) -> None:
        # The bool is a thin threshold over the ratio — they must never
        # disagree on the same measurement.
        for freq, det, tgt in (
            (261.63, 72.0, 60.0),
            (523.25, 72.0, 60.0),
            (440.0, 60.0, 72.0),
        ):
            sig = _tone(0.5, freq)
            r = octave_band_ratio(
                sig, _SR, 0.0, 0.5, detected_midi=det, target_midi=tgt
            )
            assert r is not None
            assert octave_prefers(
                sig, _SR, 0.0, 0.5, detected_midi=det, target_midi=tgt
            ) == (r > OCTAVE_SNAP_ENERGY_RATIO)


class TestLowOctaveAudit:
    """#264: the note's own spectrum flags a tracker octave-up error.

    A real low note carries its fundamental at f(P-12) AND its 3rd
    harmonic at 1.5*f(P) — two bands the written pitch's own harmonics
    (f, 2f, 3f...) can never fill. A real high note leaves both empty,
    and stem bleed that fakes only the low band does not flag.
    """

    def test_true_low_note_suspected(self) -> None:
        # Truth is C4: harmonics at 261.6, 523.2, 784.9 Hz. The tracker
        # wrote C5 — the audit sees the -12 fundamental AND the odd
        # harmonic the written pitch cannot explain.
        f_c4 = 261.63
        sig = (
            _tone(0.5, f_c4)
            + _tone(0.5, 2.0 * f_c4, amp=0.6)
            + _tone(0.5, 3.0 * f_c4, amp=0.5)
        )
        ev = low_octave_evidence(sig, _SR, 0.0, 0.5, 72.0)
        assert ev is not None
        assert low_octave_suspected(ev)

    def test_real_high_note_clean(self) -> None:
        # Truth is C5: the -12 band and the 1.5x band stay empty.
        sig = _tone(0.5, 523.25) + _tone(0.5, 1046.5, amp=0.3)
        ev = low_octave_evidence(sig, _SR, 0.0, 0.5, 72.0)
        assert not low_octave_suspected(ev)

    def test_low_band_alone_does_not_flag(self) -> None:
        # Stem bleed (a real C4 played under a sung C5) can fake the
        # low band, but only a real low fundamental also fills the
        # odd-harmonic slot — both are required, so the evidence
        # abstains before the periodicity pass.
        sig = _tone(0.5, 261.63, amp=0.6) + _tone(0.5, 523.25)
        ev = low_octave_evidence(sig, _SR, 0.0, 0.5, 72.0)
        assert not low_octave_suspected(ev)

    def test_short_span_abstains(self) -> None:
        sig = _tone(0.08, 261.63) + _tone(0.08, 523.25)
        assert low_octave_evidence(sig, _SR, 0.0, 0.08, 72.0) is None

    def test_deep_pitch_abstains(self) -> None:
        # Below the audit floor the -12 slot lands under ~65 Hz —
        # stems and the FFT window cannot resolve it honestly.
        sig = _tone(0.5, 98.0) + _tone(0.5, 196.0, amp=0.6)
        assert low_octave_evidence(sig, _SR, 0.0, 0.5, 47.0) is None

    def test_issue_maps_to_canonical_with_suggestion(self) -> None:
        # A suspected event whose canonical note survived produces one
        # octave_uncertain issue carrying the -12 remedy.
        f_c4 = 261.63
        sig = (
            _tone(1.0, f_c4)
            + _tone(1.0, 2.0 * f_c4, amp=0.6)
            + _tone(1.0, 3.0 * f_c4, amp=0.5)
        )
        ev = _ev(1, 72, 0.0, 0.6)
        n = _note(1, 72, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        issues = _octave_issues(
            sig,
            _SR,
            TimeWarp.fixed_bpm(60.0),
            Fraction(1),
            (_cleaned(ev),),
            (part,),
            ScoreRevisionId("rev-test"),
            0.0,
        )
        assert len(issues) == 1
        issue = issues[0]
        assert issue.reason is ReviewReason.OCTAVE_UNCERTAIN
        assert issue.severity is Severity.CAUTION
        assert issue.canonical_note_ids == (n.id,)
        assert issue.evidence["pitchMidi"] == 72
        assert issue.evidence["suggestedMidi"] == 60

    def test_clean_spectrum_no_issue(self) -> None:
        # A genuinely C5 note produces no flag — the audit must not
        # manufacture doubts on clean detections.
        sig = _tone(1.0, 523.25) + _tone(1.0, 1046.5, amp=0.3)
        ev = _ev(1, 72, 0.0, 0.6)
        n = _note(1, 72, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
            )
            == []
        )

    def test_written_span_audited_not_raw_event_span(self) -> None:
        # The raw events cover only 0-0.36 s (early release, clipped
        # tail) but the written note is a full beat — the audit reads
        # the written span pushed through the warp, not the raw
        # detections that could sit under the FFT floor.
        f_c4 = 261.63
        sig = (
            _tone(1.0, f_c4)
            + _tone(1.0, 2.0 * f_c4, amp=0.6)
            + _tone(1.0, 3.0 * f_c4, amp=0.5)
        )
        evs = tuple(
            _ev(i + 1, 72, i * 0.09, (i + 1) * 0.09) for i in range(4)
        )
        n = _note(1, 72, "0", "1", tuple(e.id for e in evs))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        issues = _octave_issues(
            sig,
            _SR,
            TimeWarp.fixed_bpm(60.0),
            Fraction(1),
            (_cleaned(*evs),),
            (part,),
            ScoreRevisionId("rev-test"),
            0.0,
        )
        assert len(issues) == 1
        assert issues[0].canonical_note_ids == (n.id,)
        assert issues[0].time_range.start_sec == pytest.approx(0.0)
        assert issues[0].time_range.end_sec == pytest.approx(1.0)

    def test_written_pitch_audited_not_raw_event(self) -> None:
        # The raw event tracked the 2nd harmonic (C5) but a repair
        # already wrote C4 — asking the spectrum about the RAW pitch
        # would suggest a phantom C3 fix on a correct note. The audit
        # judges the pitch the score actually carries.
        f_c4 = 261.63
        sig = (
            _tone(1.0, f_c4)
            + _tone(1.0, 2.0 * f_c4, amp=0.6)
            + _tone(1.0, 3.0 * f_c4, amp=0.5)
        )
        ev = _ev(1, 72, 0.0, 0.5)
        n = _note(1, 60, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
            )
            == []
        )

    def test_note_not_detected_on_this_buffer_skipped(self) -> None:
        # The accompaniment staff's notes were detected on the
        # accompaniment stem — judging them on the LEAD buffer reads
        # absent vocal energy as evidence about pitches never
        # measured there. Source-event membership is the scope guard.
        f_c4 = 261.63
        sig = (
            _tone(1.0, f_c4)
            + _tone(1.0, 2.0 * f_c4, amp=0.6)
            + _tone(1.0, 3.0 * f_c4, amp=0.5)
        )
        ev = _ev(1, 72, 0.0, 1.0)
        n = _note(1, 72, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(),),  # nothing detected on this buffer
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
            )
            == []
        )


class TestOctaveArbitration:
    """#80: the lead gate's losing track arbitrates octave calls.

    Two engines an octave apart on the same span means one tracked
    wrong — the note's own spectrum decides which. A confirmed
    disagreement flags octave_uncertain toward the OTHER pitch
    (both directions, not only the spectral audit's -12); a bare
    disagreement the spectrum cannot back stays silent.
    """

    def test_plus12_disagreement_spectrum_confirmed(self) -> None:
        # Truth E5 (659.26 Hz): pYIN wrote E4, the arbiter read E5 —
        # the +12 flag wins the span.
        sig = _tone(1.0, 659.26) + _tone(1.0, 1318.5, amp=0.3)
        ev = _ev(1, 64, 0.0, 1.0)
        n = _note(1, 64, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        arbiter = (_ev(9, 76, 0.0, 1.0),)
        issues = _octave_issues(
            sig,
            _SR,
            TimeWarp.fixed_bpm(60.0),
            Fraction(1),
            (_cleaned(ev),),
            (part,),
            ScoreRevisionId("rev-test"),
            0.0,
            arbiter_events=arbiter,
            arbiter_backend="basicPitch",
        )
        assert len(issues) == 1
        issue = issues[0]
        assert issue.reason is ReviewReason.OCTAVE_UNCERTAIN
        assert issue.evidence["pitchMidi"] == 64
        assert issue.evidence["suggestedMidi"] == 76
        assert issue.evidence["arbiterMidi"] == 76.0
        assert issue.evidence["arbiterBackend"] == "basicPitch"

    def test_disagreement_spectrum_rejects_no_flag(self) -> None:
        # Written F#4 is real (the spectrum carries it); the arbiter's
        # F#3 is ITS octave error — no flag manufactured.
        sig = _tone(1.0, 369.99) + _tone(1.0, 739.99, amp=0.3)
        ev = _ev(1, 66, 0.0, 1.0)
        n = _note(1, 66, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        arbiter = (_ev(9, 54, 0.0, 1.0),)
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
                arbiter_events=arbiter,
            )
            == []
        )

    def test_chord_tone_gap_is_not_an_octave_call(self) -> None:
        # 7st apart is a voicing disagreement, not an octave call —
        # the arbiter window only covers ~±12.
        sig = _tone(1.0, 329.63)
        ev = _ev(1, 64, 0.0, 1.0)
        n = _note(1, 64, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        arbiter = (_ev(9, 71, 0.0, 1.0),)
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
                arbiter_events=arbiter,
            )
            == []
        )

    def test_no_arbiter_no_arbitration(self) -> None:
        # Mono backends have no second track — the audit is unchanged.
        sig = _tone(1.0, 659.26)
        ev = _ev(1, 64, 0.0, 1.0)
        n = _note(1, 64, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
            )
            == []
        )

    def test_spectral_flag_not_double_counted(self) -> None:
        # Truth C4: the periodicity audit already flags the written
        # C5 toward C4; the arbiter agreeing adds no second issue.
        f_c4 = 261.63
        sig = (
            _tone(1.0, f_c4)
            + _tone(1.0, 2.0 * f_c4, amp=0.6)
            + _tone(1.0, 3.0 * f_c4, amp=0.5)
        )
        ev = _ev(1, 72, 0.0, 1.0)
        n = _note(1, 72, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        arbiter = (_ev(9, 60, 0.0, 1.0),)
        issues = _octave_issues(
            sig,
            _SR,
            TimeWarp.fixed_bpm(60.0),
            Fraction(1),
            (_cleaned(ev),),
            (part,),
            ScoreRevisionId("rev-test"),
            0.0,
            arbiter_events=arbiter,
        )
        assert len(issues) == 1
        assert issues[0].evidence["suggestedMidi"] == 60

    def test_uncovered_span_no_flag(self) -> None:
        # The arbiter has no opinion where it heard nothing — a median
        # over an empty span must not manufacture a disagreement.
        sig = _tone(1.0, 659.26)
        ev = _ev(1, 64, 0.0, 1.0)
        n = _note(1, 64, "0", "1", (ev.id,))
        part = Part(id="part-1", name="Horn in F", notes=(n,))
        arbiter = (_ev(9, 76, 5.0, 6.0),)  # far outside the note's span
        assert (
            _octave_issues(
                sig,
                _SR,
                TimeWarp.fixed_bpm(60.0),
                Fraction(1),
                (_cleaned(ev),),
                (part,),
                ScoreRevisionId("rev-test"),
                0.0,
                arbiter_events=arbiter,
            )
            == []
        )


class TestContextArbitration:
    """#103: melodic-context arbitration — the phrase median is a
    second opinion that needs no second engine, so it also covers
    the non-isolated path the lead gate never reaches.
    
    A note ~±12st off its local median is the phrase-boundary octave
    signature; the note's own spectrum decides whether the leap is
    real."""

    def _run(self, sig, notes, events):
        part = Part(id="part-1", name="Horn in F", notes=tuple(notes))
        return _octave_issues(
            sig,
            _SR,
            TimeWarp.fixed_bpm(60.0),
            Fraction(1),
            (_cleaned(*events),),
            (part,),
            ScoreRevisionId("rev-test"),
            0.0,
        )

    def test_context_outlier_spectrum_confirmed(self) -> None:
        # 60 bpm -> beat k spans seconds [k, k+1). The phrase sits at
        # E4 (64); one note is written E3 (52), a full octave below
        # the context median — and its span carries E4 energy, so the
        # spectrum sides with the context.
        sig = np.concatenate(
            [
                _silence(3.0),
                _tone(1.0, 329.63) + _tone(1.0, 659.26, amp=0.3),
                _silence(1.0),
            ]
        )
        ctx_evs = tuple(_ev(i + 1, 64, float(i), float(i) + 1.0) for i in (0, 1, 2, 4))
        sus = _ev(9, 52, 3.0, 4.0)
        notes = [
            _note(1, 64, "0", "1", (ctx_evs[0].id,)),
            _note(2, 64, "1", "1", (ctx_evs[1].id,)),
            _note(3, 64, "2", "1", (ctx_evs[2].id,)),
            _note(4, 52, "3", "1", (sus.id,)),
            _note(5, 64, "4", "1", (ctx_evs[3].id,)),
        ]
        issues = self._run(sig, notes, ctx_evs + (sus,))
        assert len(issues) == 1
        issue = issues[0]
        assert issue.reason is ReviewReason.OCTAVE_UNCERTAIN
        assert issue.evidence["pitchMidi"] == 52
        assert issue.evidence["suggestedMidi"] == 64
        assert issue.evidence["contextMedian"] == 64.0

    def test_real_leap_stays_silent(self) -> None:
        # Same contour, but the span holds a REAL E3 fundamental —
        # the spectrum stands by the written pitch; a bare context
        # disagreement with no spectral support must not flag.
        sig = np.concatenate(
            [
                _silence(3.0),
                _tone(1.0, 164.81) + _tone(1.0, 329.63, amp=0.3),
                _silence(1.0),
            ]
        )
        ctx_evs = tuple(_ev(i + 1, 64, float(i), float(i) + 1.0) for i in (0, 1, 2, 4))
        sus = _ev(9, 52, 3.0, 4.0)
        notes = [
            _note(1, 64, "0", "1", (ctx_evs[0].id,)),
            _note(2, 64, "1", "1", (ctx_evs[1].id,)),
            _note(3, 64, "2", "1", (ctx_evs[2].id,)),
            _note(4, 52, "3", "1", (sus.id,)),
            _note(5, 64, "4", "1", (ctx_evs[3].id,)),
        ]
        assert self._run(sig, notes, ctx_evs + (sus,)) == []

    def test_small_interval_not_an_octave_call(self) -> None:
        # A 6-st dip below the median is an ordinary leap — the
        # arbiter window only covers ~±12, like the engine path.
        sig = np.concatenate(
            [
                _silence(3.0),
                _tone(1.0, 329.63),
                _silence(1.0),
            ]
        )
        ctx_evs = tuple(_ev(i + 1, 64, float(i), float(i) + 1.0) for i in (0, 1, 2, 4))
        sus = _ev(9, 58, 3.0, 4.0)
        notes = [
            _note(1, 64, "0", "1", (ctx_evs[0].id,)),
            _note(2, 64, "1", "1", (ctx_evs[1].id,)),
            _note(3, 64, "2", "1", (ctx_evs[2].id,)),
            _note(4, 58, "3", "1", (sus.id,)),
            _note(5, 64, "4", "1", (ctx_evs[3].id,)),
        ]
        assert self._run(sig, notes, ctx_evs + (sus,)) == []

    def test_flagged_neighbour_cannot_anchor(self) -> None:
        # Two adjacent context outliers: once the first flags, it is
        # excluded from the second's context — one tracking error
        # cannot corroborate the next.
        sig = np.concatenate(
            [
                _silence(2.0),
                _tone(1.0, 329.63),  # beat 2: E4 under written E3
                _tone(1.0, 329.63, t0=3.0),  # beat 3: same
                _silence(1.0),
            ]
        )
        ctx_evs = tuple(_ev(i + 1, 64, float(i), float(i) + 1.0) for i in (0, 1, 4))
        s1 = _ev(8, 52, 2.0, 3.0)
        s2 = _ev(9, 52, 3.0, 4.0)
        notes = [
            _note(1, 64, "0", "1", (ctx_evs[0].id,)),
            _note(2, 64, "1", "1", (ctx_evs[1].id,)),
            _note(3, 52, "2", "1", (s1.id,)),
            _note(4, 52, "3", "1", (s2.id,)),
            _note(5, 64, "4", "1", (ctx_evs[2].id,)),
        ]
        issues = self._run(sig, notes, ctx_evs + (s1, s2))
        assert len(issues) == 2
        assert all(i.evidence["suggestedMidi"] == 64 for i in issues)


class TestPitchDipAudit:
    """#264: isolated chromatic semitone dips — tracker bin-snaps.

    A short note one semitone off a diatonic neighbour, chromatic
    under the local key while the line around it stays diatonic, is
    a tracker artefact until proven sung. Tests run in D major
    (fifths=2): F natural (53) is chromatic; F# (54) and C# (61) are
    diatonic.
    """

    def _issues(
        self, events: tuple[RawNoteEvent, ...], note
    ) -> list:
        part = Part(id="part-1", name="Horn in F", notes=(note,))
        return _pitch_dip_issues(
            _held_tone(),
            _SR,
            (_cleaned(*events),),
            (part,),
            2,
            (),
            ScoreRevisionId("rev-test"),
            0.0,
        )

    def test_dip_flags_with_diatonic_suggestion(self) -> None:
        # F#4 -> F4 -> C#5: the 100 ms F natural is a bin-snap suspect;
        # the suggestion is the F# it most likely belongs to.
        a, b, c = (
            _ev(1, 54, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.5),
            _ev(3, 61, 0.5, 0.9),
        )
        issues = self._issues((a, b, c), _note(1, 53, "1", "1", (b.id,)))
        assert len(issues) == 1
        issue = issues[0]
        assert issue.reason is ReviewReason.PITCH_UNCERTAIN
        assert issue.severity is Severity.CAUTION
        assert issue.evidence["pitchMidi"] == 53
        assert issue.evidence["suggestedMidi"] == 54

    def test_next_neighbour_can_suggest(self) -> None:
        # When only the NEXT note is the semitone-off diatonic
        # neighbour, it carries the suggestion.
        a, b, c = (
            _ev(1, 66, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.5),
            _ev(3, 54, 0.5, 0.9),
        )
        issues = self._issues((a, b, c), _note(1, 53, "1", "1", (b.id,)))
        assert len(issues) == 1
        assert issues[0].evidence["suggestedMidi"] == 54

    def test_long_chromatic_note_is_deliberate(self) -> None:
        # A held chromatic note is a musical choice, not a flicker.
        a, b, c = (
            _ev(1, 54, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.9),
            _ev(3, 54, 0.9, 1.3),
        )
        assert self._issues((a, b, c), _note(1, 53, "1", "2", (b.id,))) == []

    def test_chromatic_neighbour_passage_untouched(self) -> None:
        # Inside a chromatic run (prev D#51 is also chromatic) the dip
        # is line material, not a snap.
        a, b, c = (
            _ev(1, 51, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.5),
            _ev(3, 54, 0.5, 0.9),
        )
        assert self._issues((a, b, c), _note(1, 53, "1", "1", (b.id,))) == []

    def test_repeated_dips_each_flag(self) -> None:
        # The same dip figure returning flags every instance — a
        # systematic tracker dip is exactly the pattern this catches;
        # only mapped canonical notes produce issues.
        a, b, c, d = (
            _ev(1, 54, 0.0, 0.3),
            _ev(2, 53, 0.3, 0.4),
            _ev(3, 54, 0.4, 0.7),
            _ev(4, 53, 0.7, 0.8),
        )
        issues = self._issues(
            (a, b, c, d),
            _note(1, 53, "1", "1", (b.id, d.id)),
        )
        assert [i.evidence["pitchMidi"] for i in issues] == [53]

    def test_diatonic_neighbour_no_flag(self) -> None:
        # A short DIATONIC note a semitone off a diatonic neighbour is
        # a real passing tone — nothing chromatic to review.
        a, b, c = (
            _ev(1, 55, 0.0, 0.4),
            _ev(2, 54, 0.4, 0.5),
            _ev(3, 61, 0.5, 0.9),
        )
        assert self._issues((a, b, c), _note(1, 54, "1", "1", (b.id,))) == []

    def test_dip_carries_spectral_verdict(self) -> None:
        # #361: a measurable dip (>= 120 ms) reports the three-way
        # verdict next to the legacy bool so the UI can tell "detected
        # dominant" apart from "ambiguous".
        a, b, c = (
            _ev(1, 54, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.55),
            _ev(3, 61, 0.55, 0.9),
        )
        issues = self._issues((a, b, c), _note(1, 53, "1", "1", (b.id,)))
        assert len(issues) == 1
        ev = issues[0].evidence
        assert ev["spectralVerdict"] in ("suggested", "detected", "ambiguous")
        assert isinstance(ev["spectralSupport"], bool)
        assert (ev["spectralVerdict"] == "suggested") == (
            ev["spectralSupport"] is True
        )

    def test_short_dip_omits_spectral_verdict(self) -> None:
        # Under the measurement floor the keys stay absent — the UI
        # shows the "not measured" copy, not a guessed verdict.
        a, b, c = (
            _ev(1, 54, 0.0, 0.4),
            _ev(2, 53, 0.4, 0.5),
            _ev(3, 61, 0.5, 0.9),
        )
        issues = self._issues((a, b, c), _note(1, 53, "1", "1", (b.id,)))
        assert len(issues) == 1
        assert "spectralVerdict" not in issues[0].evidence
        assert "spectralSupport" not in issues[0].evidence


class TestOctaveDipSuspects:
    """#363: isolated octave excursions — the X -> X±12 -> X shape.

    A sub-280 ms note exactly an octave off BOTH identical-pitch
    neighbours is a tracker register flicker far more often than a
    sung octave. The fundamental-band ratio arbitrates: the
    neighbours' register dominant -> flagged (+auto), the detected
    register dominant -> a real leap (no flag), the middle -> an
    honest open flag.
    """

    @staticmethod
    def _leap_tone() -> np.ndarray:
        """440 Hz except a real 150 ms 880 Hz window at 0.4-0.55 s."""
        return np.concatenate(
            [
                _tone(0.4, 440.0),
                _tone(0.15, 880.0, t0=0.4),
                _tone(0.45, 440.0, t0=0.55),
            ]
        )

    @staticmethod
    def _mixed_tone() -> np.ndarray:
        """440 Hz except an equal-mix 440+880 window at 0.4-0.55 s."""
        return np.concatenate(
            [
                _tone(0.4, 440.0),
                _tone(0.15, 440.0, t0=0.4) + _tone(0.15, 880.0, t0=0.4),
                _tone(0.45, 440.0, t0=0.55),
            ]
        )

    def _suspects(
        self,
        sig: np.ndarray,
        events: tuple[RawNoteEvent, ...],
        *notes: QuantizedNote,
        exclude: frozenset = frozenset(),
    ) -> list[_PitchSuspect]:
        part = Part(id="part-1", name="Horn in F", notes=notes)
        return _octave_dip_suspects(
            sig,
            _SR,
            (_cleaned(*events),),
            (part,),
            0.0,
            exclude=exclude,
        )

    def test_v_dip_flags_with_suggested_verdict(self) -> None:
        # A4 -> A5 -> A4 over a held 440 Hz tone: the written A5 has
        # no energy on its own band — a register flicker, auto-fixable.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        suspects = self._suspects(
            _held_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
        )
        assert len(suspects) == 1
        s = suspects[0]
        assert s.detector == "octaveDip"
        assert s.pitch_midi == 81
        assert s.suggested_midi == 69
        assert s.auto is True
        assert s.evidence["spectralVerdict"] == "suggested"
        assert s.evidence["spectralSupport"] is True
        assert s.evidence["prevMidi"] == 69
        assert s.evidence["nextMidi"] == 69

    def test_dip_down_flags(self) -> None:
        # The -12 direction convicts identically (tracker drops to
        # the sub-octave).
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 57, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        suspects = self._suspects(
            _held_tone(), (a, b, c), _note(1, 57, "1", "1", (b.id,))
        )
        assert len(suspects) == 1
        assert suspects[0].suggested_midi == 69

    def test_detected_band_is_real_leap(self) -> None:
        # The audio really sits an octave up for 150 ms — flagging it
        # would be noise, so the detector stays quiet.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        assert (
            self._suspects(
                self._leap_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
            )
            == []
        )

    def test_ambiguous_band_flags_without_auto(self) -> None:
        # Equal energy on both bands — honestly undecidable: flag,
        # no auto-fix.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        suspects = self._suspects(
            self._mixed_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
        )
        assert len(suspects) == 1
        assert suspects[0].evidence["spectralVerdict"] == "ambiguous"
        assert suspects[0].auto is False

    def test_short_dip_flags_without_spectral(self) -> None:
        # A 100 ms dip is under the 120 ms measurement floor — flag
        # with no verdict keys rather than a guessed verdict.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.5),
            _ev(3, 69, 0.5, 0.9),
        )
        suspects = self._suspects(
            _held_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
        )
        assert len(suspects) == 1
        assert "spectralVerdict" not in suspects[0].evidence
        assert "spectralSupport" not in suspects[0].evidence
        assert suspects[0].auto is False

    def test_walk_shape_untouched(self) -> None:
        # Neighbours disagreeing (69 -> 81 -> 67) is a register move,
        # not a return-to-pitch flicker.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 67, 0.55, 0.9),
        )
        assert (
            self._suspects(
                _held_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
            )
            == []
        )

    def test_semitone_shape_untouched(self) -> None:
        # +-1 belongs to the semitone-dip audit, not this one.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 70, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        assert (
            self._suspects(
                _held_tone(), (a, b, c), _note(1, 70, "1", "1", (b.id,))
            )
            == []
        )

    def test_long_octave_stay_is_deliberate(self) -> None:
        # 350 ms in the other register is a landed leap, not a
        # flicker.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.75),
            _ev(3, 69, 0.75, 1.1),
        )
        assert (
            self._suspects(
                _held_tone(), (a, b, c), _note(1, 81, "1", "1", (b.id,))
            )
            == []
        )

    def test_exclude_skips_flagged_note(self) -> None:
        # A note the low-octave/arbiter audits already suspected is
        # not double-flagged.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        n = _note(1, 81, "1", "1", (b.id,))
        assert (
            self._suspects(
                _held_tone(), (a, b, c), n, exclude=frozenset({n.id})
            )
            == []
        )

    def test_unmapped_event_no_flag(self) -> None:
        # A dip event with no canonical note cannot produce a
        # score-level issue.
        a, b, c = (
            _ev(1, 69, 0.0, 0.4),
            _ev(2, 81, 0.4, 0.55),
            _ev(3, 69, 0.55, 0.9),
        )
        assert self._suspects(_held_tone(), (a, b, c)) == []


class TestAutoPitchCorrections:
    """#264: conviction-grade suspects auto-apply on the monophonic
    lead staff and report FIXED — everything else stays an open flag.
    """

    def _suspect(
        self,
        note: QuantizedNote,
        *,
        detector: str = "arbiter",
        auto: bool = True,
        suggested: int | None = None,
    ) -> _PitchSuspect:
        tgt = note.pitch_midi + 12 if suggested is None else suggested
        return _PitchSuspect(
            note_id=note.id,
            pitch_midi=note.pitch_midi,
            suggested_midi=tgt,
            detector=detector,
            time_range=TimeRange(0.0, 1.0),
            evidence={"pitchMidi": note.pitch_midi, "suggestedMidi": tgt},
            auto=auto,
        )

    def test_auto_suspect_fixes_lead_note(self) -> None:
        n = _note(1, 64, "0", "1", ())
        parts = (Part(id="p1", name="Horn in F", notes=(n,)),)
        assert _auto_pitch_fixes([self._suspect(n)], parts, allow_auto=True) == {
            n.id: 76,
        }

    def test_chords_texture_disables_auto(self) -> None:
        n = _note(1, 64, "0", "1", ())
        parts = (Part(id="p1", name="Horn in F", notes=(n,)),)
        assert (
            _auto_pitch_fixes([self._suspect(n)], parts, allow_auto=False)
            == {}
        )

    def test_accompaniment_part_stays_flag_only(self) -> None:
        n = _note(1, 64, "0", "1", ())
        parts = (
            Part(id="p1", name="accomp", notes=(n,), transposing=False),
        )
        assert (
            _auto_pitch_fixes([self._suspect(n)], parts, allow_auto=True)
            == {}
        )

    def test_unconfirmed_dip_stays_flag_only(self) -> None:
        n = _note(1, 53, "0", "1", ())
        s = self._suspect(
            n, detector="semitoneDip", auto=False, suggested=54
        )
        parts = (Part(id="p1", name="Horn in F", notes=(n,)),)
        assert _auto_pitch_fixes([s], parts, allow_auto=True) == {}

    def test_fixed_issue_reports_auto_applied(self) -> None:
        n = _note(1, 64, "0", "1", ())
        issues = _pitch_suspect_issues(
            [self._suspect(n)],
            frozenset({n.id}),
            ScoreRevisionId("rev-test"),
        )
        assert issues[0].status is IssueStatus.FIXED
        assert issues[0].evidence["autoApplied"] is True
        assert issues[0].reason is ReviewReason.OCTAVE_UNCERTAIN
        assert issues[0].canonical_note_ids == (n.id,)

    def test_open_issue_keeps_no_auto_marker(self) -> None:
        n = _note(1, 64, "0", "1", ())
        issues = _pitch_suspect_issues(
            [self._suspect(n)],
            frozenset(),
            ScoreRevisionId("rev-test"),
        )
        assert issues[0].status is IssueStatus.OPEN
        assert "autoApplied" not in issues[0].evidence

    def test_payload_rewrite_changes_revision(self) -> None:
        n = _note(1, 64, "0", "1", ())
        payload = ScoreRevisionPayload(
            tempo_map=(TempoSegment(Fraction(0), 120.0),),
            time_signature=TimeSignature(4, 4),
            key_signature=KeySignature(2),
            pickup_beats=Fraction(0),
            parts=(Part(id="p1", name="Horn in F", notes=(n,)),),
            quantization_settings={},
        )
        fixed = _pitch_fixed_payload(payload, {n.id: 76})
        assert fixed.parts[0].notes[0].pitch_midi == 76
        # Content-derived revision ids must move with the fix — an
        # issue from the pre-fix revision must not look current.
        assert fixed.revision_id() != payload.revision_id()
