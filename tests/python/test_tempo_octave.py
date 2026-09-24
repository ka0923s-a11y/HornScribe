"""IOI/IBI tempo octave census tests (#188)."""

from __future__ import annotations

from hornscribe.transcription.tempo_octave import detect_tempo_octave


def _onsets(interval: float, count: int, offset: float = 0.0) -> list[float]:
    return [offset + i * interval for i in range(count)]


class TestDetectTempoOctave:
    def test_halved_tempo_suggests_double(self) -> None:
        # Beats every 1.0s but the line attacks every ~0.5s — the
        # tracker halved the tempo.
        est = detect_tempo_octave(
            _onsets(0.5, 30),
            [i * 1.0 for i in range(16)],
        )
        assert est.suggestion == "double"

    def test_doubled_tempo_suggests_halve(self) -> None:
        # Beats every 0.25s but the line attacks every ~0.5s — the
        # tracker doubled the tempo.
        est = detect_tempo_octave(
            _onsets(0.5, 30),
            [i * 0.25 for i in range(60)],
        )
        assert est.suggestion == "halve"

    def test_matching_grid_stays_quiet(self) -> None:
        # Onsets at the beat rate — nothing to fix.
        est = detect_tempo_octave(
            _onsets(0.5, 30),
            [i * 0.5 for i in range(30)],
        )
        assert est.suggestion is None

    def test_eighth_note_writing_not_halved(self) -> None:
        # Genuine eighths: IOI is half the beat AND a quarter-ratio
        # (sixteenth) population exists — the guard keeps it quiet.
        onsets = _onsets(0.25, 40)  # sixteenths against a 1.0s beat
        est = detect_tempo_octave(onsets, [i * 1.0 for i in range(11)])
        assert est.suggestion is None

    def test_too_few_onsets_stays_quiet(self) -> None:
        est = detect_tempo_octave(_onsets(0.5, 5), [i * 1.0 for i in range(9)])
        assert est.suggestion is None

    def test_empty_beats_stays_quiet(self) -> None:
        est = detect_tempo_octave(_onsets(0.5, 30), [])
        assert est.suggestion is None
