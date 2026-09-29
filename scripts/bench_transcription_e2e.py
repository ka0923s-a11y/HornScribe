#!/usr/bin/env python3
"""End-to-end transcription accuracy benchmark (labeled audio).

Synthesizes short fixtures with *known* note ground truth, runs the real
transcription job through the worker protocol, and scores the produced
score against the truth:

- pitch sequence accuracy (order-aligned, per fixture)
- octave-flip rate (detected pitch == expected +/- 12 at matched slots)
- onset F1 at 150 ms (beat axis -> seconds via the result's own
  tempo/meter, so a tempo estimate is exercised too)
- note-count ratio

The point is a repeatable yardstick: changes to backend tuning,
cleaning, or the quantizer can be measured against labeled audio instead
of vibes. Sine fixtures are easy-mode for Basic Pitch, so this is a
floor check — a regression here means something broke badly.

Usage:
    python scripts/bench_transcription_e2e.py [--engine hornscribe-engine.exe]
                                            [--python .venv/Scripts/python.exe]
                                            [--out benchmarks/transcription_e2e]

Defaults to the repo dev engine (.venv-bp312) with PYTHONPATH=python.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import queue
import random
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

HANDSHAKE_TIMEOUT_S = 120.0
JOB_TIMEOUT_S = 420.0
ONSET_TOL_S = 0.150


# ---------------------------------------------------------------- fixtures


@dataclass(frozen=True)
class Note:
    onset: float
    offset: float
    midi: int
    amp: float = 0.8
    # lead | vox | pad | strum | bass | noise — the renderer picks a
    # waveform per timbre; "noise" ignores midi (pitched content would
    # fake a tone). "vox" carries vibrato+tremolo — the real-JPOP lead
    # shape these rows exist to exercise.
    timbre: str = "lead"
    # -1..1 stereo position. Only honoured by the stereo renderer.
    pan: float = 0.0


@dataclass(frozen=True)
class Fixture:
    name: str
    notes: tuple[Note, ...]
    note: str = ""  # shown in the report for hard-case trackers
    # Job hints. "auto"/None = the engine must estimate (the product
    # default) — estimation is then part of what the row measures.
    meter: str = "auto"
    tempo_bpm: float | None = None
    texture: str = "mono"
    # Ground truth for the report. Empty/0 means "same as the hint".
    expect_meter: str = ""
    expect_tempo_bpm: float = 0.0
    # Non-truth accompaniment rendered into the audio but excluded
    # from scoring — the JPOP-mix rows carry pad/bass/drums here while
    # `notes` stays the lead line the report measures against.
    backing: tuple[Note, ...] = ()
    # Stereo render for vocal-isolation rows — the center extractor is
    # a no-op on mono input.
    stereo: bool = False
    # Pass vocalIsolation to the job (pipeline.py: solo-melody
    # preprocess — skipped under voices/chords textures).
    vocal_isolation: bool = False

    def truth_meter(self) -> str:
        return self.expect_meter or self.meter

    def truth_tempo(self) -> float | None:
        return self.expect_tempo_bpm or self.tempo_bpm


def _note_samples(n: Note, sr: int) -> list[float]:
    """Per-note mono signal — the timbre shapes the waveform and the
    envelope edges (a pad fades in, a noise burst is attack-only).
    timbre="lead" reproduces the original sine+h2 fixture tone."""
    s0, s1 = int(n.onset * sr), int(n.offset * sr)
    count = s1 - s0
    if count <= 0:
        return []
    if n.timbre == "noise":
        rng = random.Random(int(n.onset * 1000) * 131 + n.midi)
        out = []
        for i in range(count):
            env = min(1.0, i / sr / 0.004) * math.exp(-i / sr / 0.045)
            out.append(env * (rng.random() * 2.0 - 1.0))
        return out
    f = 440.0 * 2 ** ((n.midi - 69) / 12)
    attack = 0.03 if n.timbre == "pad" else 0.01
    decay = 0.05 if n.timbre == "pad" else 0.02
    detune = (2 ** (3 / 1200), 1.0, 2 ** (-3 / 1200))
    out = []
    for i in range(count):
        t = i / sr
        env = min(1.0, t / attack) * min(1.0, (count - i) / sr / decay)
        if n.timbre == "pad":
            sig = sum(math.sin(2 * math.pi * f * d * t) for d in detune) / 3.0
        elif n.timbre == "bass":
            sig = (
                math.sin(2 * math.pi * f * t)
                + 0.5 * math.sin(2 * math.pi * f * 2 * t)
                + 0.3 * math.sin(2 * math.pi * f * 3 * t)
            )
        elif n.timbre == "vox":
            # Vibrato as phase modulation (~+-35 cents at 5.5 Hz) plus a
            # matching tremolo — the shape a sung JPOP lead has.
            vib_hz = 5.5
            depth = f * (2 ** (35 / 1200) - 1) / vib_hz
            phase = 2 * math.pi * f * t + depth * math.sin(
                2 * math.pi * vib_hz * t
            )
            trem = 1.0 + 0.12 * math.sin(2 * math.pi * vib_hz * t)
            sig = trem * (
                math.sin(phase) + 0.4 * math.sin(2 * phase)
                + 0.2 * math.sin(3 * phase)
            )
        elif n.timbre == "strum":
            # Strummed chord tone — additive harmonics, fast attack,
            # gentle decay; mid-range pitch competing with the lead.
            sig = sum(
                math.sin(2 * math.pi * f * k * t) / k for k in (1, 2, 3, 4)
            )
            env *= math.exp(-t / 0.6)
        else:
            sig = math.sin(2 * math.pi * f * t) + 0.25 * math.sin(
                2 * math.pi * f * 2 * t
            )
        out.append(env * sig)
    return out


def _synth(
    path: Path,
    notes: tuple[Note, ...],
    sr: int = 22050,
    stereo: bool = False,
) -> None:
    """Render `notes` to wav. stereo=True writes a 2-channel file with
    equal-power panning; the mono path is byte-identical to the original
    renderer (timbre="lead", pan ignored)."""
    total = int((max(n.offset for n in notes) + 0.3) * sr)
    chans = [[0.0] * total for _ in range(2 if stereo else 1)]
    for n in notes:
        sig = _note_samples(n, sr)
        s0 = int(n.onset * sr)
        if stereo:
            gl = math.cos((n.pan + 1.0) * math.pi / 4.0)
            gr = math.sin((n.pan + 1.0) * math.pi / 4.0)
        else:
            gl = gr = 1.0
        for i, v in enumerate(sig):
            s = s0 + i
            if s >= total:
                break
            if stereo:
                chans[0][s] += n.amp * v * gl
                chans[1][s] += n.amp * v * gr
            else:
                chans[0][s] += n.amp * v
    peak = max(abs(x) for c in chans for x in c) or 1.0
    frames = []
    for i in range(total):
        for c in chans:
            frames.append(struct.pack("<h", int(c[i] / peak * 30000)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(len(chans))
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(frames))


def _waltz() -> Fixture:
    # 3/4 at 120bpm: C-major scale pattern, accent on every downbeat.
    beat = 0.5
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 3
    notes = tuple(
        Note(i * beat, (i + 1) * beat - 0.03, p, 0.9 if i % 3 == 0 else 0.35)
        for i, p in enumerate(pitches)
    )
    return Fixture("waltz-3-4", notes, meter="3/4", tempo_bpm=120.0)


def _six_eight() -> Fixture:
    # 6/8: eighth-note pulses at ~286 eighths/min, downbeat + secondary
    # dotted-quarter accent so the auto meter has real evidence.
    # tempoBpm is *primary-beat* BPM — for 6/8 that is the dotted
    # quarter, so one eighth spans 60/bpm/3 seconds.
    pulse = 60.0 / 143.0 / 3.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65] * 3
    notes = tuple(
        Note(
            i * pulse,
            (i + 1) * pulse - 0.02,
            p,
            0.9 if i % 6 == 0 else (0.55 if i % 3 == 0 else 0.3),
        )
        for i, p in enumerate(pitches)
    )
    return Fixture("eighths-6-8", notes, meter="6/8", tempo_bpm=143.0)


def _sustained_scale() -> Fixture:
    # 4/4 half-note scale — longer sustains exercise offset detection
    # and the merge/ghost rules, not just onsets.
    beat = 0.5
    pitches = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67]
    notes = tuple(
        Note(i * 2 * beat, (i + 1) * 2 * beat - 0.08, p, 0.8)
        for i, p in enumerate(pitches)
    )
    return Fixture("sustained-scale-4-4", notes, meter="4/4", tempo_bpm=120.0)


def _legato_scale() -> Fixture:
    # Same ascending scale but with 20 ms gaps — a true legato line.
    # Known-weak tracker: onset detection collapses pitch transitions
    # without silence, so the expected score here is low until the
    # pipeline learns pitch-change segmentation.
    beat = 0.5
    pitches = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67]
    notes = tuple(
        Note(i * 2 * beat, (i + 1) * 2 * beat - 0.02, p, 0.8)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "legato-scale-4-4",
        notes,
        meter="4/4",
        tempo_bpm=120.0,
        note="hard case: legato transitions without silence gaps",
    )


def _triplets() -> Fixture:
    # 4/4 at 120: a pure eighth-note triplet run — triplet region
    # detection must fire or every third onset lands off-grid.
    beat = 0.5
    third = beat / 3.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 3  # 24 = 8 beats = 2 bars
    notes = tuple(
        Note(i * third, (i + 1) * third - 0.02, p, 0.85 if i % 3 == 0 else 0.4)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "triplets-4-4",
        notes,
        meter="4/4",
        tempo_bpm=120.0,
        note="eighth-note triplets — triplet-region detection",
    )


def _sixteenths() -> Fixture:
    # 16ths at 120 — 125 ms notes, the minDuration boundary.
    beat = 0.5
    sixteenth = beat / 4.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 4  # 32 = 8 beats
    notes = tuple(
        Note(
            i * sixteenth,
            (i + 1) * sixteenth - 0.015,
            p,
            0.85 if i % 4 == 0 else 0.35,
        )
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "sixteenths-4-4",
        notes,
        meter="4/4",
        tempo_bpm=120.0,
        note="16th-note run — min-duration boundary",
    )


def _pickup() -> Fixture:
    # 4/4 anacrusis: one eighth pickup, then 2 bars of quarters. If the
    # pickup is missed the whole score shifts half a beat (onset F1 dies).
    beat = 0.5
    notes = [Note(0.0, 0.22, 67, 0.8)]
    pitches = [60, 62, 64, 65, 67, 69, 71, 72]
    notes += [
        Note(0.25 + i * beat, 0.25 + (i + 1) * beat - 0.03, p, 0.8)
        for i, p in enumerate(pitches)
    ]
    return Fixture(
        "pickup-4-4",
        tuple(notes),
        meter="4/4",
        tempo_bpm=120.0,
        note="anacrusis — pickup-beat detection",
    )


def _rests() -> Fixture:
    # Quarter note + quarter rest alternating — detection must not
    # merge across the silences into sustained notes.
    beat = 0.5
    pitches = [60, 62, 64, 65, 67, 69, 71, 72]
    notes = tuple(
        Note(i * 2 * beat, i * 2 * beat + beat - 0.05, p, 0.8)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "rests-4-4",
        notes,
        meter="4/4",
        tempo_bpm=120.0,
        note="note/rest alternation — merge discipline",
    )


def _swing() -> Fixture:
    # Swung eighths at 120: long/short = 2:1 inside each beat — swing
    # feel vs triplet grid is what the engine must choose.
    beat = 0.5
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 2  # 16 = 8 beats
    notes: list[Note] = []
    t = 0.0
    for i, p in enumerate(pitches):
        dur = beat * (2.0 / 3.0 if i % 2 == 0 else 1.0 / 3.0)
        notes.append(Note(t, t + dur - 0.02, p, 0.85 if i % 2 == 0 else 0.45))
        t += dur
    return Fixture(
        "swing-4-4",
        tuple(notes),
        meter="4/4",
        tempo_bpm=120.0,
        note="swung eighths — swingFeel vs triplet grid",
    )


def _mixed_divisions() -> Fixture:
    # Quarters + 8ths + triplets + 16ths mixed per beat — the realistic
    # rhythm variety a JPOP melody carries.
    beat = 0.5
    patterns = ((1.0,), (0.5, 0.5), (1.0 / 3.0,) * 3, (0.25,) * 4)
    pitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 57]
    notes: list[Note] = []
    t = 0.0
    i = 0
    for b in range(8):
        for frac in patterns[b % 4]:
            dur = beat * frac
            notes.append(
                Note(t, t + dur - 0.015, pitches[i % len(pitches)],
                     0.85 if frac >= 0.5 else 0.4)
            )
            t += dur
            i += 1
    return Fixture(
        "mixed-divisions-4-4",
        tuple(notes),
        meter="4/4",
        tempo_bpm=120.0,
        note="q + 8th + triplets + 16ths mixed — realistic rhythm",
    )


def _dyads() -> Fixture:
    # Two-voice thirds as chords — texture=chords keeps both lines in
    # one part. Sorted by (onset, pitch) so the order-aligned pitch
    # scoring still applies.
    beat = 0.5
    lows = [48, 50, 52, 53, 55, 57, 59, 60]
    notes: list[Note] = []
    for i, p in enumerate(lows):
        notes.append(Note(i * beat, (i + 1) * beat - 0.03, p, 0.6))
        notes.append(Note(i * beat, (i + 1) * beat - 0.03, p + 4, 0.5))
    notes.sort(key=lambda n: (n.onset, n.midi))
    return Fixture(
        "dyads-4-4",
        tuple(notes),
        meter="4/4",
        tempo_bpm=120.0,
        texture="chords",
        note="third dyads — chord texture voice tracking",
    )


def _jpop_mix_parts() -> tuple[tuple[Note, ...], tuple[Note, ...]]:
    """8-bar 4/4 @128 JPOP-style mix — returns (lead truth, backing).

    Lead: a pentatonic-ish melody with eighth/sixteenth/syncopation
    variety, panned dead center the way pop production places vocals.
    Backing: per-bar triad pads spread wide, center-ish bass quarters,
    and noise-burst drums — none of it counts toward the truth, so the
    report reads "how much of the lead survived the arrangement"."""
    sixteenth = 60.0 / 128.0 / 4.0
    melody = (
        # Am F C G x2 — the classic JPOP progression.
        (4, 76), (4, 79), (2, 81), (2, 79), (4, 76),
        (2, 77), (2, 76), (2, 77), (2, 79), (8, 81),
        (4, 79), (4, 76), (2, 74), (2, 72), (4, 74),
        # bar4 starts a step off 74: a same-pitch hit across the barline
        # would merge under the 20 ms truth gap (< the 30 ms merge gap)
        # and score as a miss that is really a legato seam.
        (2, 72), (2, 76), (2, 74), (2, 71), (8, 74),
        (4, 76), (2, 77), (2, 79), (4, 81), (4, 79),
        # bar6 likewise — 79 would continue bar5's held 79.
        (2, 74), (2, 77), (4, 76), (4, 74), (4, 72),
        (4, 74), (2, 72), (2, 74), (4, 76), (4, 72),
        (2, 71), (2, 74), (12, 76),
    )
    lead: list[Note] = []
    t = 0.0
    for dur, midi in melody:
        lead.append(Note(t, t + dur * sixteenth - 0.02, midi, 0.75))
        t += dur * sixteenth
    backing: list[Note] = []
    chords = (
        (57, 60, 64, 45),  # Am
        (53, 57, 60, 41),  # F
        (55, 60, 64, 48),  # C
        (55, 59, 62, 43),  # G
    )
    bar = 16 * sixteenth
    for b in range(8):
        pad, bass_root = chords[b % 4][:3], chords[b % 4][3]
        for k, p in enumerate(pad):
            backing.append(
                Note(b * bar, (b + 1) * bar - 0.05, p, 0.22, "pad",
                     (-0.55, 0.55, -0.3)[k])
            )
        for q in range(4):
            backing.append(
                Note(b * bar + q * 4 * sixteenth,
                     b * bar + (q + 1) * 4 * sixteenth - 0.03,
                     bass_root, 0.4, "bass", -0.15)
            )
        # kick 1+3, snare 2+4, hats on offbeat eighths.
        for q, pan, amp in ((0, 0.2, 0.5), (1, -0.2, 0.4), (2, 0.2, 0.5),
                            (3, -0.2, 0.4)):
            backing.append(
                Note(b * bar + q * 4 * sixteenth,
                     b * bar + q * 4 * sixteenth + 0.06,
                     60, amp, "noise", pan)
            )
        for e in range(4):
            backing.append(
                Note(b * bar + (e * 2 + 1) * 2 * sixteenth,
                     b * bar + (e * 2 + 1) * 2 * sixteenth + 0.04,
                     60, 0.18, "noise", 0.4)
            )
    return tuple(lead), tuple(backing)


def _jpop_mix_raw() -> Fixture:
    lead, backing = _jpop_mix_parts()
    return Fixture(
        "jpop-mix-raw",
        lead,
        backing=backing,
        stereo=True,
        meter="4/4",
        tempo_bpm=128.0,
        texture="melody",
        note="4-layer mix, no separation — lead survival baseline",
    )


def _jpop_mix_vocal() -> Fixture:
    lead, backing = _jpop_mix_parts()
    return Fixture(
        "jpop-mix-vocal",
        lead,
        backing=backing,
        stereo=True,
        vocal_isolation=True,
        meter="4/4",
        tempo_bpm=128.0,
        texture="melody",
        note="same mix + vocalIsolation — center-extraction payoff",
    )


def _jpop_mix_hard_parts() -> tuple[tuple[Note, ...], tuple[Note, ...]]:
    """Harder variant of the JPOP mix: the lead sings with vibrato
    (timbre="vox") while an eighth-note strummed chord arpeggio lives
    in the same octave — pitched accompaniment competing directly with
    the melody band, not safely below it."""
    lead_raw, backing = _jpop_mix_parts()
    lead = tuple(
        Note(n.onset, n.offset, n.midi, 0.6, "vox", n.pan) for n in lead_raw
    )
    strum: list[Note] = []
    chords = (
        (57, 60, 64),  # Am
        (53, 57, 60),  # F
        (55, 60, 64),  # C
        (55, 59, 62),  # G
    )
    sixteenth = 60.0 / 128.0 / 4.0
    bar = 16 * sixteenth
    tones = [0, 1, 2, 1]  # low-mid-high-mid arpeggio per beat
    for b in range(8):
        chord = chords[b % 4]
        for e in range(8):
            p = chord[tones[e % 4]] + 12  # compete in the lead octave
            strum.append(
                Note(
                    b * bar + e * 2 * sixteenth,
                    b * bar + (e + 1) * 2 * sixteenth - 0.02,
                    p,
                    0.26,
                    "strum",
                    (-0.4, 0.4)[e % 2],
                )
            )
    return lead, backing + tuple(strum)


def _jpop_mix_hard_vocal() -> Fixture:
    lead, backing = _jpop_mix_hard_parts()
    return Fixture(
        "jpop-mix-hard-vocal",
        lead,
        backing=backing,
        stereo=True,
        vocal_isolation=True,
        meter="4/4",
        tempo_bpm=128.0,
        texture="melody",
        note="vibrato lead + same-octave strum — the hard JPOP case",
    )


def _jpop_mix_hard_raw() -> Fixture:
    lead, backing = _jpop_mix_hard_parts()
    return Fixture(
        "jpop-mix-hard-raw",
        lead,
        backing=backing,
        stereo=True,
        meter="4/4",
        tempo_bpm=128.0,
        texture="melody",
        note="hard mix without separation — contrast row",
    )


def _auto_44() -> Fixture:
    # No hints — the product default. Estimation must find 4/4 @ 96.
    beat = 60.0 / 96.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 2
    notes = tuple(
        Note(i * beat, (i + 1) * beat - 0.03, p, 0.9 if i % 4 == 0 else 0.4)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "auto-4-4-96",
        notes,
        expect_meter="4/4",
        expect_tempo_bpm=96.0,
        note="unhinted: meter + tempo estimated",
    )


def _auto_34() -> Fixture:
    # Unhinted waltz at 132 — triple meter with beat accents.
    beat = 60.0 / 132.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 3
    notes = tuple(
        Note(i * beat, (i + 1) * beat - 0.03, p, 0.9 if i % 3 == 0 else 0.4)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "auto-3-4-132",
        notes,
        expect_meter="3/4",
        expect_tempo_bpm=132.0,
        note="unhinted waltz — triple-meter estimation",
    )


def _auto_68() -> Fixture:
    # Unhinted 6/8 — compound meter is the hardest auto case (it can
    # legitimately read as 2/4 or 3/4 depending on accent weight).
    pulse = 60.0 / 143.0 / 3.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65] * 3
    notes = tuple(
        Note(
            i * pulse,
            (i + 1) * pulse - 0.02,
            p,
            0.9 if i % 6 == 0 else (0.55 if i % 3 == 0 else 0.3),
        )
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "auto-6-8-143",
        notes,
        expect_meter="6/8",
        expect_tempo_bpm=143.0,
        note="unhinted compound meter",
    )


def _tempo_step() -> Fixture:
    # 2 bars at 100 then 2 bars at 140 — the score's tempoMap must carry
    # both segments for the beat->sec conversion to score correctly.
    notes: list[Note] = []
    t = 0.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 2
    seg_bpm = [100.0] * 8 + [140.0] * 8
    for i, p in enumerate(pitches):
        dur = 60.0 / seg_bpm[i]
        notes.append(Note(t, t + dur - 0.03, p, 0.85 if i % 4 == 0 else 0.5))
        t += dur
    return Fixture(
        "tempo-step-4-4",
        tuple(notes),
        expect_meter="4/4",
        note="100->140 mid-piece — tempo-map tracking (auto tempo)",
    )


FIXTURES = (
    _waltz,
    _six_eight,
    _sustained_scale,
    _legato_scale,
    _triplets,
    _sixteenths,
    _pickup,
    _rests,
    _swing,
    _mixed_divisions,
    _dyads,
    _jpop_mix_raw,
    _jpop_mix_vocal,
    _jpop_mix_hard_raw,
    _jpop_mix_hard_vocal,
    _auto_44,
    _auto_34,
    _auto_68,
    _tempo_step,
)


# ------------------------------------------------------- protocol driver


def _request(proc: subprocess.Popen, method: str, payload: dict) -> None:
    line = json.dumps(
        {
            "v": 1,
            "kind": "request",
            "id": method + "-" + str(time.time_ns() % 1_000_000),
            "method": method,
            "payload": payload,
        }
    )
    assert proc.stdin is not None
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def _read_frame(proc: subprocess.Popen, timeout_s: float) -> dict:
    q: queue.Queue = queue.Queue()

    def pump() -> None:
        assert proc.stdout is not None
        q.put(proc.stdout.readline())

    threading.Thread(target=pump, daemon=True).start()
    line = q.get(timeout=timeout_s)
    if not line:
        raise RuntimeError("engine closed stdout")
    return json.loads(line)


def _spawn(args: argparse.Namespace) -> subprocess.Popen:
    if args.engine:
        cmd = [str(args.engine)]
        env = None
    else:
        cmd = [str(args.python), "-m", "hornscribe.worker"]
        import os

        env = dict(os.environ)
        env["PYTHONPATH"] = str(REPO / "python") + (
            ";" + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def _run_job(proc: subprocess.Popen, audio: Path, fx: Fixture) -> dict:
    _request(
        proc,
        "job.start",
        {
            "jobKind": "transcription",
            "params": {
                "audioPath": str(audio),
                "meter": fx.meter,
                "texture": fx.texture,
                "backend": "basicPitch",
                **(
                    {"tempoBpm": fx.tempo_bpm}
                    if fx.tempo_bpm is not None
                    else {}
                ),
                **({"vocalIsolation": True} if fx.vocal_isolation else {}),
            },
        },
    )
    deadline = time.monotonic() + JOB_TIMEOUT_S
    while time.monotonic() < deadline:
        frame = _read_frame(proc, max(1.0, deadline - time.monotonic()))
        if frame.get("kind") == "response":
            if frame.get("error"):
                raise RuntimeError(f"job.start error: {frame['error']}")
            continue
        evt = frame.get("payload") or {}
        phase = evt.get("phase")
        if phase == "completed":
            return evt.get("result") or {}
        if phase == "failed":
            raise RuntimeError(f"job failed: {evt.get('error')}")
    raise TimeoutError(f"job exceeded {JOB_TIMEOUT_S:.0f}s")


# ------------------------------------------------------------- scoring


def _frac(value) -> float:
    if isinstance(value, str) and "/" in value:
        n, d = value.split("/", 1)
        return float(n) / float(d)
    return float(value)


def _detected_notes(result: dict) -> list[tuple[float, int]]:
    """(onset_sec, midi) rows — beats converted piecewise via the
    result's own tempoMap so a wrong tempo pick (or a missing tempo
    segment) shows up as onset error."""
    doc = result.get("scoreDocument") or {}
    content = doc.get("content") or {}
    parts = content.get("parts") or []
    meta = result.get("meta") or {}
    meter = str(meta.get("meter") or "4/4")
    if "/" in meter:
        num_s, den_s = meter.split("/", 1)
        num = int(num_s)
    else:
        num = 4
    # scoreDocument startBeat counts *denominator* units (scorebuild.py:
    # onset_ql / (4/den)) — for 6/8 one "beat" is an eighth. tempoBpm
    # counts *primary* beats (compound: dotted quarter = 3/2 ql).
    beat_count = num // 3 if (num % 3 == 0 and num > 3) else num
    # tempoMap bpm counts *primary* beats; a doc beat (denominator unit)
    # is 1/doc_per_primary of a primary beat (6/8 -> 3 eighths each).
    doc_per_primary = num / beat_count
    # Piecewise conversion over the score's own tempoMap so multi-segment
    # scores (tempo changes) are scored on their real map, not a median.
    segs: list[tuple[float, float]] = []
    for s in content.get("tempoMap") or []:
        try:
            segs.append((_frac(s["startBeat"]), float(s["bpm"])))
        except (KeyError, TypeError, ValueError):
            continue
    segs.sort()
    if not segs:
        segs = [(0.0, float(meta.get("tempoBpm") or 120.0))]
    if segs[0][0] > 0.0:
        segs.insert(0, (0.0, segs[0][1]))
    seg_starts = [s for s, _ in segs]
    seg_sec = [0.0]
    for i in range(1, len(segs)):
        span = segs[i][0] - segs[i - 1][0]
        seg_sec.append(
            seg_sec[-1] + span * (60.0 / segs[i - 1][1]) / doc_per_primary
        )

    def beat_to_sec(b: float) -> float:
        i = bisect.bisect_right(seg_starts, b) - 1
        return seg_sec[i] + (b - seg_starts[i]) * (60.0 / segs[i][1]) / doc_per_primary

    out: list[tuple[float, int]] = []
    for part in parts:
        for n in part.get("notes") or []:
            if n.get("deleted"):
                continue
            out.append((beat_to_sec(_frac(n["startBeat"])), int(n["pitchMidi"])))
    out.sort()
    return out


def _align_pitches(expected: list[int], got: list[int]) -> dict:
    """Order-preserving alignment (Needleman-Wunsch, gap=-1, sub=-2).
    Reports exact / octave-off / other mismatches."""
    n, m = len(expected), len(got)
    # classic DP
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] - 1
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] - 1
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sub = 0 if expected[i - 1] == got[j - 1] else -2
            dp[i][j] = max(
                dp[i - 1][j - 1] + sub, dp[i - 1][j] - 1, dp[i][j - 1] - 1
            )
    # traceback
    i, j = n, m
    pairs = []
    ins = dele = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (
            0 if expected[i - 1] == got[j - 1] else -2
        ):
            pairs.append((expected[i - 1], got[j - 1]))
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] - 1:
            dele += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    exact = sum(1 for a, b in pairs if a == b)
    octave = sum(1 for a, b in pairs if abs(a - b) == 12)
    mismatched = len(pairs) - exact - octave
    return {
        "expected": n,
        "detected": m,
        "matched": len(pairs),
        "exact": exact,
        "octaveOff": octave,
        "mismatch": mismatched,
        "missing": dele,
        "extra": ins,
        "pitchAccuracy": round(exact / n, 4) if n else 0.0,
        "noteRatio": round(m / n, 4) if n else 0.0,
    }


def _onset_f1(expected: list[float], got: list[float]) -> dict:
    used = [False] * len(got)
    tp = 0
    errors: list[float] = []
    for e in expected:
        best = None
        best_d = ONSET_TOL_S
        for k, g in enumerate(got):
            if used[k]:
                continue
            d = abs(g - e)
            if d <= best_d:
                best, best_d = k, d
        if best is not None:
            used[best] = True
            tp += 1
            errors.append(best_d)
    fp = len(got) - tp
    fn = len(expected) - tp
    f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 1.0
    med = sorted(errors)[len(errors) // 2] if errors else None
    return {
        "onsetF1@150ms": round(f1, 4),
        "medianOnsetErrMs": round(med * 1000.0, 1) if med is not None else None,
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


# ----------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    # Console can be cp932 on Windows — the report text (arrows,
    # em-dashes in notes) must not die on encode.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap.add_argument("--engine", type=Path, default=None,
                    help="frozen hornscribe-engine binary")
    ap.add_argument(
        "--python",
        type=Path,
        default=REPO / ".venv-bp312" / "Scripts" / "python.exe",
    )
    ap.add_argument("--out", type=Path, default=REPO / "benchmarks" / "transcription_e2e")
    ap.add_argument(
        "--only",
        type=str,
        default="",
        help="comma-separated fixture names to run (default: all)",
    )
    args = ap.parse_args()
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    rows = []
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for make in FIXTURES:
            fx = make()
            if only and fx.name not in only:
                continue
            wav = tdp / (fx.name + ".wav")
            _synth(wav, fx.notes + fx.backing, stereo=fx.stereo)
            proc = _spawn(args)
            t0 = time.monotonic()
            result: dict | None = None
            job_error: str | None = None
            try:
                _request(proc, "engine.handshake", {"protocolVersion": 1})
                hs = _read_frame(proc, HANDSHAKE_TIMEOUT_S)
                if hs.get("error"):
                    raise RuntimeError(f"handshake: {hs['error']}")
                result = _run_job(proc, wav, fx)
            except Exception as exc:  # a failing job is a result too
                job_error = str(exc)
            finally:
                proc.kill()
            elapsed = time.monotonic() - t0

            if job_error is not None:
                row = {
                    "fixture": fx.name,
                    "note": fx.note,
                    "error": job_error,
                    "runtimeSec": round(elapsed, 1),
                }
                rows.append(row)
                print(json.dumps(row, ensure_ascii=False))
                continue
            assert result is not None
            got = _detected_notes(result)
            exp_p = [n.midi for n in fx.notes]
            got_p = [m for _, m in got]
            seq = _align_pitches(exp_p, got_p)
            ons = _onset_f1([n.onset for n in fx.notes], [o for o, _ in got])
            meta = result.get("meta") or {}
            row = {
                "fixture": fx.name,
                "note": fx.note,
                "tempoBpmDetected": meta.get("tempoBpm"),
                "meterDetected": meta.get("meter"),
                "meterOk": meta.get("meter") == fx.truth_meter(),
                "tempoRatio": (
                    round(float(meta.get("tempoBpm")) / fx.truth_tempo(), 3)
                    if meta.get("tempoBpm") and fx.truth_tempo()
                    else None
                ),
                "runtimeSec": round(elapsed, 1),
                **seq,
                **ons,
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    stem = args.out
    if only:
        # A filtered run must not erase the rows it skipped — merge over
        # the existing report, ordered by the FIXTURES list.
        prior = {}
        try:
            prior = {
                r["fixture"]: r
                for r in json.loads(
                    stem.with_suffix(".json").read_text(encoding="utf-8")
                ).get("rows", [])
                if isinstance(r, dict) and "fixture" in r
            }
        except Exception:
            prior = {}
        prior.update({r["fixture"]: r for r in rows})
        order = {make().name: k for k, make in enumerate(FIXTURES)}
        rows = sorted(
            prior.values(), key=lambda r: order.get(r["fixture"], 999)
        )
    stem.with_suffix(".json").write_text(
        json.dumps({"rows": rows}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    md = ["# E2E transcription accuracy benchmark", ""]
    md.append(
        "| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms"
        " | med err ms | tempo (ratio) | meter (ok) | s | note |"
    )
    md.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        md.append(
            (
                f"| {r['fixture']} | {r['pitchAccuracy']} | {r['octaveOff']} "
                f"| {r['missing']}/{r['extra']} | {r['onsetF1@150ms']} | {r['medianOnsetErrMs']} "
                f"| {r['tempoBpmDetected']} ({r['tempoRatio']}) "
                f"| {r['meterDetected']} ({r['meterOk']}) "
                f"| {r['runtimeSec']} | {r['note']} |"
            )
            if "error" not in r
            else (
                f"| {r['fixture']} | - | - | - | - | - | - | - "
                f"| {r['runtimeSec']} | **job failed**: {r['error']} |"
            )
        )
    stem.with_suffix(".md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"wrote {stem.with_suffix('.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
