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
from hornscribe.domain.review import ReviewReason, Severity
from hornscribe.domain.score import Part, QuantizedNote
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.transcription.boundary import boundary_flags
from hornscribe.transcription.clean import CleanedEvents
from hornscribe.transcription.pipeline import _boundary_issues

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
        )
        assert [
            i for i in issues
            if i.evidence.get("suggestedKind") == "split"
        ] == []

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
        )
        unc = [
            i for i in issues
            if i.evidence.get("suggestedKind") == "uncertain"
        ]
        assert len(unc) == 1
        assert unc[0].severity is Severity.INFO


