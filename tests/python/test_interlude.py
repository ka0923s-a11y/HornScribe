"""#379 instrumental-break lead borrowing — the vocal-silent span
detector and the top-voice borrow over accompaniment voices."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

from hornscribe.domain.events import RawNoteEvent  # noqa: E402
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId  # noqa: E402
from hornscribe.transcription.clean import CleanedEvents  # noqa: E402
from hornscribe.transcription.interlude import (  # noqa: E402
    borrow_interlude_lead,
    borrowed_note_ids,
    vocal_silent_spans,
)

_SR = 22050
_REV = TranscriptionRevisionId("rev-test0000001")


def _ev(i: int, onset: float, offset: float, midi: float) -> RawNoteEvent:
    return RawNoteEvent(
        id=RawNoteEventId(f"rne-a{i:06d}"),
        transcription_revision=_REV,
        pitch_midi=midi,
        onset_sec=onset,
        offset_sec=offset,
        confidence=0.8,
    )


def _voice(*evs: RawNoteEvent) -> CleanedEvents:
    return CleanedEvents(events=tuple(evs), dropped_too_short=0, merged=0, clipped_overlaps=0)


def _tone(t0: float, t1: float, amp: float, sr: int = _SR) -> np.ndarray:
    t = np.arange(int(t0 * sr), int(t1 * sr)) / sr
    return (t * 0.0 + 1.0) * amp * np.sin(2 * np.pi * 220.0 * t)


def _stem(sr: int = _SR) -> np.ndarray:
    """Vocal stem sketch: voice on 0-6 s and 12-16 s, silent 6-12 s."""
    y = np.zeros(16 * sr)
    y[: 6 * sr] += _tone(0, 6, 0.2)
    y[12 * sr :] += _tone(0, 4, 0.2)
    # separation residue stays far below the active level
    y += np.random.default_rng(7).normal(0, 0.002, y.size)
    return y


class TestVocalSilentSpans:
    def test_finds_the_break(self) -> None:
        spans = vocal_silent_spans(_stem(), _SR)
        assert len(spans) == 1
        assert spans[0][0] == pytest.approx(6.0, abs=0.3)
        assert spans[0][1] == pytest.approx(12.0, abs=0.3)

    def test_short_phrase_gaps_are_not_breaks(self) -> None:
        # 1.5 s of silence is a breath, not an interlude.
        y = np.zeros(8 * _SR)
        y[: 3 * _SR] += _tone(0, 3, 0.2)
        y[int(4.5 * _SR) :] += _tone(0, 3.5, 0.2)
        assert vocal_silent_spans(y, _SR) == []

    def test_all_silent_stem_means_instrumental_input(self) -> None:
        y = np.zeros(10 * _SR) + np.random.default_rng(1).normal(
            0, 0.002, 10 * _SR
        )
        assert vocal_silent_spans(y, _SR) == []

    def test_offset_shifts_to_source_time(self) -> None:
        spans = vocal_silent_spans(_stem(), _SR, time_offset_sec=30.0)
        assert spans[0][0] == pytest.approx(36.0, abs=0.3)


class TestBorrowInterludeLead:
    def test_top_voice_events_land_in_the_lead(self) -> None:
        span = [(6.0, 12.0)]
        low = _voice(_ev(1, 6.0, 12.0, 48.0))
        top = _voice(_ev(2, 6.2, 7.0, 72.0), _ev(3, 7.2, 8.4, 74.0),
                     _ev(4, 8.6, 10.0, 71.0), _ev(5, 10.2, 11.8, 69.0))
        borrowed, used = borrow_interlude_lead((), [low, top], span)
        assert len(borrowed) == 4
        assert used == [(6.0 + 0.15, 12.0 - 0.15)]
        assert all(e.source == "interlude-lead" for e in borrowed)
        assert {e.pitch_midi for e in borrowed} == {72.0, 74.0, 71.0, 69.0}

    def test_low_voice_is_never_borrowed_even_when_it_covers(self) -> None:
        span = [(6.0, 12.0)]
        bass = _voice(_ev(1, 6.0, 12.0, 40.0))
        borrowed, _ = borrow_interlude_lead((), [bass], span)
        assert borrowed == []

    def test_vocal_reentry_always_wins(self) -> None:
        span = [(6.0, 12.0)]
        lead = (_ev(90, 11.5, 13.0, 76.0),)  # vocal back at 11.5
        top = _voice(
            _ev(2, 6.3, 7.5, 72.0),
            _ev(4, 7.7, 9.0, 71.0),
            _ev(5, 9.2, 11.0, 73.0),
            _ev(3, 11.6, 12.2, 74.0),  # overlaps the re-entry -> dropped
        )
        borrowed, _ = borrow_interlude_lead(lead, [top], span)
        assert [e.pitch_midi for e in borrowed] == [72.0, 71.0, 73.0]

    def test_edge_events_clip_or_drop_by_inside_fraction(self) -> None:
        span = [(6.0, 12.0)]
        voice = _voice(
            _ev(1, 5.0, 6.05, 70.0),   # mostly outside -> dropped
            _ev(2, 6.5, 11.9, 72.0),  # fully inside
        )
        borrowed, _ = borrow_interlude_lead((), [voice], span)
        assert [e.pitch_midi for e in borrowed] == [72.0]

    def test_below_coverage_threshold_borrows_nothing(self) -> None:
        span = [(6.0, 12.0)]
        thin = _voice(_ev(1, 6.0, 7.0, 72.0))  # 17% coverage < 40%
        borrowed, used = borrow_interlude_lead((), [thin], span)
        assert borrowed == []
        assert used == []

    def test_ids_and_sorting_survive(self) -> None:
        span = [(6.0, 12.0)]
        voice = _voice(_ev(9, 8.0, 9.0, 74.0), _ev(8, 6.5, 7.0, 72.0),
                       _ev(7, 9.5, 11.0, 70.0))
        borrowed, _ = borrow_interlude_lead((), [voice], span)
        assert [str(e.id) for e in borrowed] == [
            "rne-a000008",
            "rne-a000009",
            "rne-a000007",
        ]


class TestBorrowedNoteIds:
    """#381: canonical ids for the instrumental_break marker — the
    borrowed events are shared with the accompaniment part, so the
    helper takes only the lead part's notes by contract."""

    def test_maps_borrowed_events_to_canonical_notes(self) -> None:
        class _N:
            def __init__(self, nid: str, src: list[str]) -> None:
                self.id = nid
                self.source_event_ids = src

        notes = [
            _N("sn-1", ["rne-000001", "rne-a000010"]),
            _N("sn-2", ["rne-000002"]),
            _N("sn-3", ["rne-a000011"]),
        ]
        assert borrowed_note_ids(
            notes, {"rne-a000010", "rne-a000011"}
        ) == ("sn-1", "sn-3")

    def test_no_borrows_maps_to_empty(self) -> None:
        class _N:
            def __init__(self, nid: str, src: list[str]) -> None:
                self.id = nid
                self.source_event_ids = src

        notes = [_N("sn-1", ["rne-000001"])]
        assert borrowed_note_ids(notes, set()) == ()
