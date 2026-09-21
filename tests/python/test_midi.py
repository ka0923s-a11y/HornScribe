"""ENG-001: playback.mid semantics — sounding/concert pitch only."""

from __future__ import annotations

import io
from fractions import Fraction

import mido
import pytest

from conftest import make_score
from hornscribe.export import export_filename, export_score_bundle
from hornscribe.export.midi import (
    MidiExportError,
    playback_midi_bytes,
    write_playback_midi,
)


def _parse(data: bytes) -> mido.MidiFile:
    return mido.MidiFile(file=io.BytesIO(data))


def _note_ons(mid: mido.MidiFile) -> list[mido.Message]:
    return [
        m
        for track in mid.tracks
        for m in track
        if m.type == "note_on" and m.velocity > 0
    ]


def test_playback_mid_contains_concert_pitches() -> None:
    """Golden: horn source pitches are written as sounding/concert in MIDI."""
    score = make_score([(60, 0, 1), (66, 1, 1), (58, 2, 1)])
    mid = _parse(playback_midi_bytes(score))
    assert [m.note for m in _note_ons(mid)] == [60, 66, 58]


def test_playback_mid_is_valid_smf_format1() -> None:
    mid = _parse(playback_midi_bytes(make_score()))
    assert mid.type == 1
    assert mid.ticks_per_beat == 480
    # conductor track + one track per part
    assert len(mid.tracks) == 1 + len(make_score().payload.parts)


def test_playback_mid_tempo_map() -> None:
    mid = _parse(playback_midi_bytes(make_score(bpm=120.0)))
    tempos = [m.tempo for m in mid.tracks[0] if m.type == "set_tempo"]
    assert tempos == [500000]  # 120 quarter-notes/minute
    ts = [m for m in mid.tracks[0] if m.type == "time_signature"]
    assert (ts[0].numerator, ts[0].denominator) == (4, 4)
    ks = [m for m in mid.tracks[0] if m.type == "key_signature"]
    assert ks[0].key == "C"


def test_playback_mid_key_signature_meta() -> None:
    mid = _parse(playback_midi_bytes(make_score(fifths=-2)))
    ks = [m for m in mid.tracks[0] if m.type == "key_signature"]
    assert ks[0].key == "Bb"


def test_playback_mid_timing_is_deterministic() -> None:
    score = make_score([(60, 0, 1), (66, 1, 1)])
    assert playback_midi_bytes(score) == playback_midi_bytes(score)


def test_playback_mid_duration_in_ticks() -> None:
    score = make_score([(60, 0, 2)])  # half note at 4/4 -> 960 ticks
    mid = _parse(playback_midi_bytes(score))
    on, off = None, None
    for m in mid.tracks[1]:
        if m.type == "note_on":
            on = m
        if m.type == "note_off":
            off = m
    assert on is not None and off is not None
    assert on.time == 0 and off.time == 960  # delta ticks: quarter=480


def test_playback_mid_velocity() -> None:
    score = make_score([(60, 0, 1)])
    mid = _parse(playback_midi_bytes(score))
    assert _note_ons(mid)[0].velocity == 80


def test_eighth_beat_unit_tempo() -> None:
    """6/8 bpm counts eighth beats -> quarter tempo halves."""
    score = make_score([(60, 0, 1)], beats_per_measure=6, beat_unit=8, bpm=120.0)
    mid = _parse(playback_midi_bytes(score))
    tempos = [m.tempo for m in mid.tracks[0] if m.type == "set_tempo"]
    assert tempos == [1000000]  # 60 quarters/min


def test_non_integer_tick_rejected() -> None:
    score = make_score([(60, 0, Fraction(1, 3))])  # triplet beat -> 160 ticks, exact
    assert playback_midi_bytes(score)  # 480/3 is integer -> ok
    bad = make_score([(60, 0, Fraction(1, 960))])
    with pytest.raises(MidiExportError):
        playback_midi_bytes(bad)


def test_no_horn_in_f_midi_in_filename_policy(tmp_path) -> None:
    """`horn_in_f.mid` is never a default export (master plan §4.3)."""
    paths = export_score_bundle(make_score(), tmp_path)
    names = {p.name for p in paths.values()}
    assert names == {"concert.musicxml", "horn_in_f.musicxml", "playback.mid"}
    assert "horn_in_f.mid" not in names
    with pytest.raises(ValueError):
        export_filename("horn_in_f_mid")


def test_export_filename_prefix() -> None:
    assert export_filename("concert", "MySong") == "MySong_concert.musicxml"
    assert export_filename("horn_in_f", "MySong") == "MySong_horn_in_f.musicxml"
    assert export_filename("playback", "MySong") == "MySong_playback.mid"
    assert export_filename("playback") == "playback.mid"


def test_write_playback_midi(tmp_path) -> None:
    out = write_playback_midi(make_score(), tmp_path / "playback.mid")
    assert out.read_bytes()[:4] == b"MThd"


def test_no_gui_dependency() -> None:
    """The export stack must not pull GUI frameworks into the process."""
    import sys

    offenders = ("tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "wx", "gi")
    loaded = {m.split(".")[0] for m in sys.modules}
    assert not (set(offenders) & loaded)
