"""``playback.mid`` export (ENG-001; master plan §4.3 / §11, dev plan Phase 5).

``playback.mid`` always contains *sounding/concert* pitches — the canonical
pitch space — so any generic MIDI player reproduces the transcribed audio.

A written-pitch ``horn_in_f.mid`` is intentionally **not** produced:
Standard MIDI files carry no transposing-instrument semantics, so written
(+P5) notes would sound a perfect fifth too high and the file would be
ambiguous about its own pitch space.
"""

from __future__ import annotations

import io
from fractions import Fraction
from pathlib import Path

import mido

from hornscribe.domain.score import ScoreDocument

DEFAULT_TICKS_PER_BEAT = 480
"""MIDI ticks per quarter note (PPQ)."""

GM_PROGRAM_HORN = 60
"""General MIDI program number (0-based) for French Horn (GM #61)."""

_DEFAULT_VELOCITY = 64

# fifths -> MIDI key-signature meta-event key names (mido vocabulary).
_MAJOR_KEYS = {
    -7: "Cb", -6: "Gb", -5: "Db", -4: "Ab", -3: "Eb", -2: "Bb", -1: "F",
    0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
}
_MINOR_KEYS = {
    -7: "Abm", -6: "Ebm", -5: "Bbm", -4: "Fm", -3: "Cm", -2: "Gm", -1: "Dm",
    0: "Am", 1: "Em", 2: "Bm", 3: "F#m", 4: "C#m", 5: "G#m", 6: "D#m", 7: "A#m",
}


class MidiExportError(ValueError):
    """Canonical content that cannot be represented in a Standard MIDI File."""


def _beat_to_tick(beat: Fraction, beat_unit: int, ticks_per_beat: int) -> int:
    """Canonical beats -> MIDI ticks (tick = quarters * PPQ)."""
    exact = beat * Fraction(4 * ticks_per_beat, beat_unit)
    rounded = round(exact)
    if rounded != exact:
        raise MidiExportError(f"beat {beat} is not representable in {ticks_per_beat} PPQ ticks")
    return int(rounded)


def _tempo_us_per_quarter(bpm: float, beat_unit: int) -> int:
    """Score bpm (per beat-unit beat) -> microseconds per MIDI quarter note."""
    if bpm <= 0:
        raise MidiExportError(f"invalid tempo bpm: {bpm}")
    quarters_per_minute = bpm * 4 / beat_unit
    return round(60_000_000 / quarters_per_minute)


def _key_signature_name(fifths: int, mode: str) -> str | None:
    if mode == "major":
        return _MAJOR_KEYS.get(fifths)
    if mode == "minor":
        return _MINOR_KEYS.get(fifths)
    return None


def playback_midi_bytes(
    score: ScoreDocument,
    *,
    ticks_per_beat: int = DEFAULT_TICKS_PER_BEAT,
    gm_program: int = GM_PROGRAM_HORN,
) -> bytes:
    """Serialize *score* to a ``playback.mid`` SMF (format 1) byte string.

    Note pitches are the canonical sounding/concert ``pitch_midi`` values;
    tempo map, meter, and key signature are emitted as meta-events.
    Deterministic: identical input yields identical bytes.
    """
    payload = score.payload
    ts = payload.time_signature

    mid = mido.MidiFile(type=1, ticks_per_beat=ticks_per_beat)

    # Track 0: conductor track with meter / key / tempo map.
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("track_name", name="conductor", time=0))
    conductor.append(
        mido.MetaMessage(
            "time_signature",
            numerator=ts.beats_per_measure,
            denominator=ts.beat_unit,
            time=0,
        )
    )
    key_name = _key_signature_name(payload.key_signature.fifths, payload.key_signature.mode)
    if key_name is not None:
        conductor.append(mido.MetaMessage("key_signature", key=key_name, time=0))

    total_ticks = 0
    tempo_events: list[tuple[int, mido.MetaMessage]] = []
    for seg in payload.tempo_map:
        tick = _beat_to_tick(seg.start_beat, ts.beat_unit, ticks_per_beat)
        us_per_quarter = _tempo_us_per_quarter(seg.bpm, ts.beat_unit)
        tempo_events.append(
            (tick, mido.MetaMessage("set_tempo", tempo=us_per_quarter, time=0))
        )
    if not tempo_events:
        tempo_events.append((0, mido.MetaMessage("set_tempo", tempo=500000, time=0)))

    last = 0
    for tick, msg in sorted(tempo_events, key=lambda e: e[0]):
        msg.time = tick - last
        conductor.append(msg)
        last = tick

    for part_index, part in enumerate(payload.parts):
        track = mido.MidiTrack()
        mid.tracks.append(track)
        channel = min(part_index, 15)
        events: list[tuple[int, int, mido.Message]] = []
        events.append((0, 0, mido.Message("program_change", channel=channel, program=gm_program)))
        for n in part.notes:
            on_tick = _beat_to_tick(n.start_beat, ts.beat_unit, ticks_per_beat)
            off_tick = _beat_to_tick(n.start_beat + n.duration_beats, ts.beat_unit, ticks_per_beat)
            if off_tick <= on_tick:
                raise MidiExportError(f"note {n.id} has non-positive duration in ticks")
            total_ticks = max(total_ticks, off_tick)
            velocity = n.velocity if n.velocity is not None else _DEFAULT_VELOCITY
            note_on = mido.Message(
                "note_on", channel=channel, note=n.pitch_midi, velocity=velocity
            )
            note_off = mido.Message(
                "note_off", channel=channel, note=n.pitch_midi, velocity=0
            )
            # note_off sorts before note_on at the same tick (order key 1 < 2)
            events.append((on_tick, 2, note_on))
            events.append((off_tick, 1, note_off))
        events.sort(key=lambda e: (e[0], e[1]))
        track.append(mido.MetaMessage("track_name", name=part.name, time=0))
        last = 0
        for tick, _order, msg in events:
            msg.time = tick - last
            track.append(msg)
            last = tick
        track.append(mido.MetaMessage("end_of_track", time=0))

    conductor.append(mido.MetaMessage("end_of_track", time=max(0, total_ticks - last)))

    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def write_playback_midi(
    score: ScoreDocument,
    path: Path,
    *,
    ticks_per_beat: int = DEFAULT_TICKS_PER_BEAT,
    gm_program: int = GM_PROGRAM_HORN,
) -> Path:
    """Write :func:`playback_midi_bytes` to *path*."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = playback_midi_bytes(
        score, ticks_per_beat=ticks_per_beat, gm_program=gm_program
    )
    path.write_bytes(data)
    return path
