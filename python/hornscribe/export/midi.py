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
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path

import mido

from hornscribe.domain.score import ScoreDocument, primary_beat_beats

DEFAULT_TICKS_PER_BEAT = 480
"""MIDI ticks per quarter note (PPQ)."""

GM_PROGRAM_HORN = 60
"""General MIDI program number (0-based) for French Horn (GM #61)."""

_DEFAULT_VELOCITY = 64

# MIDI pitch-bend is a 14-bit value centered at 8192; mido exposes it
# signed (-8192..8191), so emission code works in the signed domain.
# The canonical curve is in semitones over the standard +/-2 range.
_BEND_CENTER = 8192
_BEND_UNITS_PER_SEMITONE = 4096

# #333: MIDI pitch bend is channel-scoped — a bend active on a
# channel detunes EVERY note sounding there, so a bent note needs
# its channel to itself for the bend's span. Channel 9 is the GM
# drum kit; bend-capable channels are the remaining fifteen.
_DRUM_CHANNEL = 9
_FREE_CHANNELS = tuple(c for c in range(16) if c != _DRUM_CHANNEL)

def _any_overlap(
    spans: tuple[tuple[Fraction, Fraction], ...] | list[tuple[Fraction, Fraction]],
    span: tuple[Fraction, Fraction],
) -> bool:
    return any(span[0] < s[1] and s[0] < span[1] for s in spans)


def _assign_channels(
    parts: tuple,
) -> tuple[list[int], list[dict[int, int]], list[set[int]]]:
    """Per-note channel assignment for the whole file (#333).

    Returns (bases, channels, drops):``bases[i]`` is part *i* 's home
    channel; ``channels[i][j]`` the channel note *j* of part *i*
    actually plays on; ``drops[i]`` holds indexes of bent notes that
    could not get an exclusive channel (their bends are skipped —
    only possible past fifteen simultaneously sounding bends).

    Rules:
    * a bent note takes the first channel with NO note sounding over
      its span — it detunes everything else there, so the channel
      must be exclusive for that span (a "claim");
    * a straight note takes the first channel with no bend claim
      over its span — ordinary polyphony on a channel is fine, only
      bend claims poison it;
    * channel order is the part's base first, then the free pool —
      conflict-free scores keep today's exact bytes.
    """
    claimed: dict[int, list[tuple[Fraction, Fraction]]] = {}
    occupied: dict[int, list[tuple[Fraction, Fraction]]] = {}

    def span_of(n) -> tuple[Fraction, Fraction]:
        return (n.start_beat, n.start_beat + n.duration_beats)

    # Skip the GM drum channel for part homes — a horn part landing on
    # channel 9 would play as percussion (part 10+ hit this before).
    bases = [_FREE_CHANNELS[min(i, len(_FREE_CHANNELS) - 1)] for i in range(len(parts))]
    others = [
        [c for c in _FREE_CHANNELS if c != base] for base in bases
    ]
    channels: list[dict[int, int]] = [dict() for _ in parts]
    drops: list[set[int]] = [set() for _ in parts]

    # Pass 1 (file-wide): bent notes claim exclusive channels.
    for pi, part in enumerate(parts):
        base, pool = bases[pi], others[pi]
        for i, n in sorted(
            enumerate(part.notes), key=lambda e: e[1].start_beat
        ):
            if not n.pitch_bends:
                continue
            span = span_of(n)
            ch = next(
                (
                    c
                    for c in (base, *pool)
                    if not _any_overlap(occupied.get(c, ()), span)
                ),
                None,
            )
            if ch is None:
                drops[pi].add(i)
                ch = base
                # The note still SOUNDS on the base channel — mark it
                # occupied so a later bend cannot claim the channel and
                # detune it.
                occupied.setdefault(ch, []).append(span)
            else:
                claimed.setdefault(ch, []).append(span)
                occupied.setdefault(ch, []).append(span)
            channels[pi][i] = ch

    # Pass 2 (file-wide): straight notes avoid claimed channels
    # over their own span — a claim would detune them.
    for pi, part in enumerate(parts):
        base, pool = bases[pi], others[pi]
        for i, n in sorted(
            enumerate(part.notes), key=lambda e: e[1].start_beat
        ):
            if n.pitch_bends:
                continue
            span = span_of(n)
            ch = next(
                (
                    c
                    for c in (base, *pool)
                    if not _any_overlap(claimed.get(c, ()), span)
                ),
                base,
            )
            channels[pi][i] = ch
            occupied.setdefault(ch, []).append(span)

    return bases, channels, drops


def _bend_value(semitones: float) -> int:
    """Canonical bend semitones -> mido pitchwheel value (-8192..8191)."""
    v = int(round(_BEND_CENTER + semitones * _BEND_UNITS_PER_SEMITONE))
    return max(-_BEND_CENTER, min(_BEND_CENTER - 1, v - _BEND_CENTER))

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


def _beat_to_tick_swung(
    beat: Fraction, beat_unit: int, ticks_per_beat: int
) -> int:
    """Tick conversion for swing-warped positions (#206).

    A swung phase like 4/9 of a quarter is not exactly representable in
    PPQ — the warp is a playback feel, so the nearest tick is honest
    (unlike written notation positions, which must stay exact).
    """
    return int(round(beat * Fraction(4 * ticks_per_beat, beat_unit)))


def _swing_warper(
    swing_feel: Fraction | None,
) -> Callable[[Fraction], Fraction]:
    """Written-beat phase warp for swung playback (#206).

    Mirrors the desktop audition warp (score/swingWarp.ts): inside each
    canonical beat cell the written midpoint (phase 1/2) sounds at
    phase ``swing_feel``; the two halves scale linearly so beat onsets
    and measure boundaries stay fixed. Straight scores get the
    identity — identical input still yields identical bytes.
    """
    if swing_feel is None:
        return lambda beat: beat
    p = swing_feel

    def warp(beat: Fraction) -> Fraction:
        cell = beat.numerator // beat.denominator
        phase = beat - cell
        if phase <= Fraction(1, 2):
            swung = phase * 2 * p
        else:
            swung = p + (phase - Fraction(1, 2)) * 2 * (1 - p)
        return Fraction(cell) + swung

    return warp


def _tempo_us_per_quarter(bpm: float, primary_beat_ql: Fraction) -> int:
    """Score bpm (per primary beat) -> microseconds per MIDI quarter note."""
    if bpm <= 0:
        raise MidiExportError(f"invalid tempo bpm: {bpm}")
    quarters_per_minute = bpm * float(primary_beat_ql)
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
    swing_warp = _swing_warper(payload.swing_feel)

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
    # #157: tempo_map bpm counts primary beats (6/8 -> dotted quarter),
    # not payload beats — match the notation referent.
    beat_ql = Fraction(4, ts.beat_unit)
    primary_ql = primary_beat_beats(ts, beat_ql) * beat_ql
    for seg in payload.tempo_map:
        tick = _beat_to_tick(seg.start_beat, ts.beat_unit, ticks_per_beat)
        us_per_quarter = _tempo_us_per_quarter(seg.bpm, primary_ql)
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

    # #333: channel-scoped bends need exclusivity — assign real
    # channels before emitting so a bend never detunes a neighbour.
    bases, note_channels, bend_drops = _assign_channels(payload.parts)
    for part_index, part in enumerate(payload.parts):
        track = mido.MidiTrack()
        mid.tracks.append(track)
        base = bases[part_index]
        events: list[tuple[int, int, mido.Message]] = []
        used_channels = sorted({base, *note_channels[part_index].values()})
        for ch in used_channels:
            events.append(
                (
                    0,
                    0,
                    mido.Message(
                        "program_change", channel=ch, program=gm_program
                    ),
                )
            )
        # Emit in start order: a prior note's wheel reset (order key 1,
        # insertion order) must land before the next note's pre-bend at
        # the same tick even when part.notes is not time-sorted.
        for ni, n in sorted(
            enumerate(part.notes), key=lambda e: e[1].start_beat
        ):
            channel = note_channels[part_index].get(ni, base)
            # #206: swung scores shift offbeat onsets/offsets just like
            # the audition does — otherwise the exported MIDI plays
            # straight against a score marked Swing.
            to_tick = (
                _beat_to_tick_swung
                if payload.swing_feel is not None
                else _beat_to_tick
            )
            on_tick = to_tick(
                swing_warp(n.start_beat), ts.beat_unit, ticks_per_beat
            )
            off_tick = to_tick(
                swing_warp(n.start_beat + n.duration_beats),
                ts.beat_unit,
                ticks_per_beat,
            )
            if off_tick <= on_tick:
                if payload.swing_feel is not None:
                    # Tick rounding collapsed a swung micro-note — keep
                    # it audible at one tick rather than failing the
                    # whole export.
                    off_tick = on_tick + 1
                else:
                    raise MidiExportError(f"note {n.id} has non-positive duration in ticks")
            total_ticks = max(total_ticks, off_tick)
            velocity = n.velocity if n.velocity is not None else _DEFAULT_VELOCITY
            note_on = mido.Message(
                "note_on", channel=channel, note=n.pitch_midi, velocity=velocity
            )
            note_off = mido.Message(
                "note_off", channel=channel, note=n.pitch_midi, velocity=0
            )
            # Tick order: prev note_off (0) -> prev wheel-center and
            # this note's bends (1, insertion order keeps the reset
            # first) -> note_on (2): a bend at the onset is a pre-bend
            # instead of landing a tick late.
            events.append((on_tick, 2, note_on))
            events.append((off_tick, 0, note_off))
            # #174: emit the performed bend curve (normalized 0..1 across
            # the note's span) as pitch_bend messages, then return the
            # wheel to center so the next note starts clean.
            if n.pitch_bends and ni not in bend_drops[part_index]:
                span_ticks = off_tick - on_tick
                for b in n.pitch_bends:
                    btick = on_tick + int(round(b.time_sec * span_ticks))
                    events.append(
                        (
                            btick,
                            1,
                            mido.Message(
                                "pitchwheel",
                                channel=channel,
                                pitch=_bend_value(b.bend_semitones),
                            ),
                        )
                    )
                events.append(
                    (
                        off_tick,
                        1,
                        mido.Message(
                            "pitchwheel", channel=channel, pitch=0
                        ),
                    )
                )
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
