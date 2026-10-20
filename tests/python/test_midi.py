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


def _bend_score(entries) -> object:
    """Single-part score whose notes may carry canonical bend curves.

    ``entries``: ``(pitch_midi, start_beat, duration_beats, bends)``
    where ``bends`` is ``[(normalized_time, semitones), ...]`` or None.
    """
    from hornscribe.domain.events import PitchBendPoint
    from hornscribe.domain.ids import (
        IdAllocator,
        ScoreNoteId,
        derive_project_id,
    )
    from hornscribe.domain.score import (
        KeySignature,
        Part,
        QuantizedNote,
        ScoreDocument,
        ScoreRevisionPayload,
        TempoSegment,
        TimeSignature,
    )

    alloc = IdAllocator("sn")
    qnotes = tuple(
        QuantizedNote(
            id=ScoreNoteId(alloc.allocate()),
            source_event_ids=(),
            pitch_midi=pitch,
            start_beat=Fraction(start),
            duration_beats=Fraction(dur),
            velocity=80,
            pitch_bends=tuple(
                PitchBendPoint(time_sec=t, bend_semitones=s)
                for t, s in (bends or ())
            ),
        )
        for pitch, start, dur, bends in entries
    )
    payload = ScoreRevisionPayload(
        tempo_map=(TempoSegment(start_beat=Fraction(0), bpm=120.0),),
        time_signature=TimeSignature(4, 4),
        key_signature=KeySignature(0, "major"),
        pickup_beats=Fraction(0),
        parts=(Part(id="part-1", name="Horn in F", notes=qnotes),),
        quantization_settings={"grid": "1/16"},
    )
    return ScoreDocument(
        project_id=derive_project_id({"fixture": "test"}),
        payload=payload,
        title="Bends",
    )


def _track_messages_at_ticks(track: mido.MidiTrack):
    t = 0
    for m in track:
        t += m.time
        yield t, m


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
    """#157: 6/8 bpm counts primary (dotted-quarter) beats -> 180 quarters/min."""
    score = make_score([(60, 0, 1)], beats_per_measure=6, beat_unit=8, bpm=120.0)
    mid = _parse(playback_midi_bytes(score))
    tempos = [m.tempo for m in mid.tracks[0] if m.type == "set_tempo"]
    assert tempos == [333333]  # 60e6 / (120 * 3/2) quarters/min


def _meter_changing_score():
    """4/4 -> 6/8 at beat 8, with a tempo mark inside each meter (#410)."""
    from hornscribe.domain.ids import (
        IdAllocator,
        ScoreNoteId,
        derive_project_id,
    )
    from hornscribe.domain.score import (
        KeySignature,
        MeterChange,
        Part,
        QuantizedNote,
        ScoreDocument,
        ScoreRevisionPayload,
        TempoSegment,
        TimeSignature,
    )

    alloc = IdAllocator("sn")
    qnotes = tuple(
        QuantizedNote(
            id=ScoreNoteId(alloc.allocate()),
            source_event_ids=(),
            pitch_midi=pitch,
            start_beat=Fraction(start),
            duration_beats=Fraction(dur),
            velocity=80,
        )
        for pitch, start, dur in ((60, 0, 1), (62, 8, 1))
    )
    payload = ScoreRevisionPayload(
        tempo_map=(
            TempoSegment(start_beat=Fraction(0), bpm=120.0),
            TempoSegment(start_beat=Fraction(8), bpm=60.0),
        ),
        time_signature=TimeSignature(4, 4),
        key_signature=KeySignature(0, "major"),
        pickup_beats=Fraction(0),
        meter_changes=(
            MeterChange(Fraction(0), TimeSignature(4, 4), Fraction(0)),
            MeterChange(Fraction(8), TimeSignature(6, 8), Fraction(0)),
        ),
        parts=(Part(id="part-1", name="Horn in F", notes=qnotes),),
        quantization_settings={"grid": "1/16"},
    )
    return ScoreDocument(
        project_id=derive_project_id({"fixture": "test"}),
        payload=payload,
        title="Meter change",
    )


def test_meter_change_segment_uses_local_referent() -> None:
    """#410: a tempo mark inside a mid-piece 6/8 section counts
    dotted-quarter beats, not head-meter quarters — and the meter
    change itself lands on the conductor track."""
    mid = _parse(playback_midi_bytes(_meter_changing_score()))
    tempos = [
        (t, m.tempo)
        for t, m in _track_messages_at_ticks(mid.tracks[0])
        if m.type == "set_tempo"
    ]
    # 120 quarters/min at tick 0; 60 dotted-quarters/min = 90
    # quarters/min -> 666667 us/quarter at beat 8 (8 * 480 ticks).
    # The head-meter reading produced 1000000 (60 quarters/min).
    assert tempos == [(0, 500000), (8 * 480, 666667)]
    sigs = [
        (t, (m.numerator, m.denominator))
        for t, m in _track_messages_at_ticks(mid.tracks[0])
        if m.type == "time_signature"
    ]
    assert sigs == [(0, (4, 4)), (8 * 480, (6, 8))]


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
    assert names == {
        "concert.musicxml",
        "horn_in_f.musicxml",
        "b_flat.musicxml",
        "playback.mid",
    }
    assert "horn_in_f.mid" not in names
    with pytest.raises(ValueError):
        export_filename("horn_in_f_mid")


def test_export_filename_prefix() -> None:
    assert export_filename("concert", "MySong") == "MySong_concert.musicxml"
    assert export_filename("horn_in_f", "MySong") == "MySong_horn_in_f.musicxml"
    assert export_filename("b_flat", "MySong") == "MySong_b_flat.musicxml"
    assert export_filename("playback", "MySong") == "MySong_playback.mid"
    assert export_filename("playback") == "playback.mid"


def test_write_playback_midi(tmp_path) -> None:
    out = write_playback_midi(make_score(), tmp_path / "playback.mid")
    assert out.read_bytes()[:4] == b"MThd"


def test_overlapping_bends_get_separate_channels() -> None:
    # #333: simultaneous bent notes cannot share a channel — a bend is
    # channel-scoped, so sharing detunes whichever note does not own it.
    score = _bend_score(
        [
            (60, 0, 2, [(0.0, 0.5), (1.0, -0.5)]),
            (67, 0, 2, [(0.0, -1.0), (1.0, 0.0)]),
        ]
    )
    mid = _parse(playback_midi_bytes(score))
    ons = [m for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0]
    assert len(ons) == 2
    assert ons[0].channel != ons[1].channel
    wheels = [m for m in mid.tracks[1] if m.type == "pitchwheel"]
    assert {m.channel for m in wheels} == {ons[0].channel, ons[1].channel}
    # every channel that plays a note also gets its program
    progs = {m.channel for m in mid.tracks[1] if m.type == "program_change"}
    assert progs == {ons[0].channel, ons[1].channel}


def test_straight_note_moves_off_a_claimed_channel() -> None:
    # #333: a straight note overlapping a bend must not be detuned —
    # it leaves the claimed channel instead of sharing it.
    score = _bend_score(
        [
            (60, 0, 2, [(0.5, 1.0)]),
            (65, 0, 1, None),
        ]
    )
    mid = _parse(playback_midi_bytes(score))
    ons = [m for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0]
    bent = next(m for m in ons if m.note == 60)
    straight = next(m for m in ons if m.note == 65)
    wheels = [m for m in mid.tracks[1] if m.type == "pitchwheel"]
    assert wheels
    assert all(m.channel == bent.channel for m in wheels)
    assert straight.channel != bent.channel


def test_sequential_bends_share_channel_when_safe() -> None:
    # Back-to-back bends keep the old behaviour — the wheel resets
    # between notes so the base channel stays usable (#333).
    score = _bend_score(
        [
            (60, 0, 1, [(0.5, 0.5)]),
            (62, 1, 1, [(0.5, -0.5)]),
        ]
    )
    mid = _parse(playback_midi_bytes(score))
    ons = [m for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0]
    assert {m.channel for m in ons} == {0}
    wheels = [m for m in mid.tracks[1] if m.type == "pitchwheel"]
    assert wheels and all(m.channel == 0 for m in wheels)
    # the wheel returns to centre between the notes (mido: centre = 0)
    assert any(m.pitch == 0 for m in wheels)


def test_bend_at_onset_is_a_pre_bend() -> None:
    # A bend point at time 0 must set the wheel BEFORE the note sounds,
    # not a tick late (#333).
    score = _bend_score([(64, 0, 1, [(0.0, 1.0), (1.0, 0.0)])])
    mid = _parse(playback_midi_bytes(score))
    seq = [
        (t, m.type)
        for t, m in _track_messages_at_ticks(mid.tracks[1])
        if m.type in ("note_on", "pitchwheel", "note_off")
    ]
    bend_idx = seq.index((0, "pitchwheel"))
    on_idx = seq.index((0, "note_on"))
    assert bend_idx < on_idx


def test_bend_pool_exhaustion_drops_bends_not_notes() -> None:
    # Past fifteen simultaneous bends the pool runs out — the extra
    # note still plays, just without its curve (#333).
    score = _bend_score([(48 + i, 0, 4, [(0.5, 0.5)]) for i in range(16)])
    mid = _parse(playback_midi_bytes(score))
    ons = [m for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0]
    assert len(ons) == 16
    assert len({m.channel for m in ons}) == 15
    wheels = [m for m in mid.tracks[1] if m.type == "pitchwheel"]
    # 15 claimed channels, one bend value + one centre reset each
    assert len(wheels) == 30


def test_no_gui_dependency() -> None:
    """The export stack must not pull GUI frameworks into the process."""
    import sys

    offenders = ("tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "wx", "gi")
    loaded = {m.split(".")[0] for m in sys.modules}
    assert not (set(offenders) & loaded)


def _abs_note_ons(mid: mido.MidiFile) -> list[int]:
    """Absolute ticks of every note_on (velocity>0) across tracks."""
    out: list[int] = []
    for track in mid.tracks:
        t = 0
        for m in track:
            t += m.time
            if m.type == "note_on" and m.velocity > 0:
                out.append(t)
    return out


def test_swing_feel_warps_offbeats() -> None:
    """#206: a swing-marked score exports swung timing, not straight."""
    from dataclasses import replace

    # Eighth-note pairs: written 1/2 sounds at 2/3 of the beat.
    score = make_score([(60, 0, "1/2"), (62, "1/2", "1/2"), (64, 1, 1)])
    score = replace(
        score,
        payload=replace(score.payload, swing_feel=Fraction(2, 3)),
    )
    mid = _parse(playback_midi_bytes(score))
    # 480 PPQ per quarter: written 1/2 -> sounding 2/3 -> 320 ticks.
    assert _abs_note_ons(mid) == [0, 320, 480]


def test_straight_score_bytes_unchanged_by_swing_path() -> None:
    """No swing_feel -> the export path is byte-identical to before."""
    score = make_score([(60, 0, "1/2"), (62, "1/2", "1/2"), (64, 1, 1)])
    mid = _parse(playback_midi_bytes(score))
    assert _abs_note_ons(mid) == [0, 240, 480]


def test_accompaniment_part_exports_piano_program() -> None:
    """#227: the non-transposing accompaniment staff declares Piano in
    the MusicXML export — playback.mid must honour the same timbre
    instead of playing the backing lines on the lead's horn program."""
    from dataclasses import replace

    from hornscribe.domain.score import Part

    score = make_score([(60, 0, 1)])
    accomp_note = score.payload.parts[0].notes[0]
    score = replace(
        score,
        payload=replace(
            score.payload,
            parts=(
                score.payload.parts[0],
                Part(
                    id="part-2",
                    name="accompaniment",
                    notes=(accomp_note,),
                    transposing=False,
                ),
            ),
        ),
    )
    mid = _parse(playback_midi_bytes(score))
    lead_progs = {
        m.program for m in mid.tracks[1] if m.type == "program_change"
    }
    acc_progs = {
        m.program for m in mid.tracks[2] if m.type == "program_change"
    }
    assert lead_progs == {60}
    assert acc_progs == {0}


def test_different_programs_partition_channels() -> None:
    """#227: SMF channel state is file-global — two parts with
    different programs must never share a channel, or one part's
    program_change would steal the other's timbre."""
    from dataclasses import replace

    from hornscribe.domain.score import Part

    score = make_score([(60, 0, 1), (62, 1, 1), (64, 2, 1)])
    acc_notes = tuple(score.payload.parts[0].notes)
    score = replace(
        score,
        payload=replace(
            score.payload,
            parts=(
                score.payload.parts[0],
                Part(
                    id="part-2",
                    name="accompaniment",
                    notes=acc_notes,
                    transposing=False,
                ),
            ),
        ),
    )
    mid = _parse(playback_midi_bytes(score))
    lead_chs = {
        m.channel for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0
    }
    acc_chs = {
        m.channel for m in mid.tracks[2] if m.type == "note_on" and m.velocity > 0
    }
    assert lead_chs
    assert acc_chs
    assert lead_chs.isdisjoint(acc_chs)


def _two_part_score():
    """Lead part plus a non-transposing accompaniment — the shape the
    mixer's per-part gains index into (#407)."""
    from dataclasses import replace

    from hornscribe.domain.score import Part

    score = make_score([(60, 0, 1), (64, 1, 1)])
    acc_notes = tuple(score.payload.parts[0].notes)
    return replace(
        score,
        payload=replace(
            score.payload,
            parts=(
                score.payload.parts[0],
                Part(
                    id="part-2",
                    name="accompaniment",
                    notes=acc_notes,
                    transposing=False,
                ),
            ),
        ),
    )


def test_part_gains_scale_velocities() -> None:
    """#407: a half-open fader bounces half-velocity notes — the MIDI
    carries the audition balance instead of a flat default."""
    mid = _parse(
        playback_midi_bytes(_two_part_score(), part_gains=[0.5, 1.0])
    )
    lead_vel = {
        m.velocity
        for m in mid.tracks[1]
        if m.type == "note_on" and m.velocity > 0
    }
    acc_vel = {
        m.velocity
        for m in mid.tracks[2]
        if m.type == "note_on" and m.velocity > 0
    }
    assert lead_vel == {40}  # base velocity 80 scaled by 0.5
    assert acc_vel == {80}


def test_part_gain_zero_drops_the_part() -> None:
    """#407: a mixer-silenced part leaves no notes in the bounce — the
    same audible-parts contract the client enforces, applied
    engine-side so a raw RPC cannot bypass it."""
    mid = _parse(
        playback_midi_bytes(_two_part_score(), part_gains=[1.0, 0.0])
    )
    lead_on = [
        m for m in mid.tracks[1] if m.type == "note_on" and m.velocity > 0
    ]
    acc_on = [
        m for m in mid.tracks[2] if m.type == "note_on" and m.velocity > 0
    ]
    assert len(lead_on) == 2
    assert acc_on == []


def test_part_gains_clamp_and_never_emit_velocity_zero() -> None:
    """#407: out-of-range gains clamp to 0..1, and a tiny gain floors
    at velocity 1 — a velocity-0 note_on is a note_off to parsers."""
    mid = _parse(
        playback_midi_bytes(_two_part_score(), part_gains=[0.001, 2.0])
    )
    lead_vel = {
        m.velocity
        for m in mid.tracks[1]
        if m.type == "note_on" and m.velocity > 0
    }
    acc_vel = {
        m.velocity
        for m in mid.tracks[2]
        if m.type == "note_on" and m.velocity > 0
    }
    assert lead_vel == {1}
    assert acc_vel == {80}


def test_part_gains_none_keeps_flat_velocities() -> None:
    """#407: omitting the option reproduces the historical file —
    callers that never mixed still export full-velocity notes."""
    mid = _parse(playback_midi_bytes(_two_part_score()))
    for track in mid.tracks[1:]:
        assert {
            m.velocity
            for m in track
            if m.type == "note_on" and m.velocity > 0
        } == {80}
