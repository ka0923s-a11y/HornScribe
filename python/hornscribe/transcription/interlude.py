"""Instrumental-break lead borrowing (#379).

The lead part decodes the vocal stem monophonically, so a JPOP
instrumental break (intro / kansou / outro) prints as rests while the
guitar or synth hook sits inside the accompaniment stem's polyphonic
lattice.  When the caller already decoded that stem for the accompaniment
part, the break's lead line is usually its most-articulated top voice —
this module finds the vocal-silent spans and borrows those events into
the lead staff.

Borrowed events keep their own rne-a* ids and are tagged
source="interlude-lead" — audits scoped to the vocal stem (octave /
pitch-dip / boundary) exempt them by id, since the note's spectral
evidence lives on the accompaniment stem, not the vocal estimate.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from hornscribe.domain.events import RawNoteEvent
from hornscribe.transcription.clean import CleanedEvents

#: Shortest vocal-silent run that reads as an instrumental break — a
#: breath pause between phrases is 1-2 s even in ballads, a real
#: intro/kansou spans bars. 3.0 s keeps the gate conservative.
MIN_INTERLUDE_SEC = 3.0
#: Silence runs closer than this merge — a residue blip or cough in the
#: vocal stem must not split a genuine break in two.
MAX_SILENCE_GAP_SEC = 0.8
#: A frame counts as vocal-silent below this fraction of the stem's own
#: active level (p90). Separation residue sits far under it.
_SILENT_REL = 0.10
#: Whole-song silence is an instrumental track, not a break — the lead
#: backend already ran on the full mix there, so borrowing would only
#: duplicate the found line.
_MAX_SILENT_COVERAGE = 0.85
#: Keep borrowed notes clear of the vocal's re-entry — boundary frames
#: blur vocal and accompaniment evidence.
_EDGE_GUARD_SEC = 0.15
#: The borrowed voice must actually play through the break (fraction of
#: the span its events cover).
_MIN_SPAN_COVERAGE = 0.40
#: Borrowed notes are the break's lead line — the bass register stays in
#: the accompaniment part even when it tops the coverage table.
_MIN_BORROW_MIDI = 55.0  # G3
#: A clipped fragment needs at least this much of its duration inside
#: the span to survive.
_MIN_INSIDE_FRACTION = 0.5
_MIN_BORROW_DUR_SEC = 0.08

_FRAME_SEC = 256 / 22050.0  # ~11.6 ms hop for the RMS scan
_FRAME_LEN = 1024


def vocal_silent_spans(
    samples: Any,
    sample_rate: int,
    *,
    time_offset_sec: float = 0.0,
) -> list[tuple[float, float]]:
    """Contiguous spans where the vocal stem carries residue, not a voice.

    Returns `[(start_sec, end_sec)]` in the caller's timeline
    (`time_offset_sec` shifts stem-relative frames to absolute source
    seconds, matching the event clock). Empty when the stem is too short
    to judge, when no break exists, or when the whole file reads silent
    (instrumental input — nothing to borrow a lead *for*, the lead
    backend already read the full mix).
    """
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    y = np.asarray(samples, dtype=np.float64)
    if y.size < _FRAME_LEN * 8:
        return []
    hop = max(1, int(_FRAME_SEC * sample_rate))
    n_frames = 1 + (y.size - _FRAME_LEN) // hop
    idx = np.arange(n_frames) * hop
    frames = y[idx[:, None] + np.arange(_FRAME_LEN)[None, :]]
    rms = np.sqrt((frames * frames).mean(axis=1))
    active = float(np.percentile(rms, 90.0))
    if active <= 0.0:
        return []
    silent = rms < active * _SILENT_REL
    if float(silent.mean()) > _MAX_SILENT_COVERAGE:
        return []
    # Frame gap -> seconds at this hop; close runs merge across small
    # residue blips.
    gap_frames = int(MAX_SILENCE_GAP_SEC / _FRAME_SEC)
    min_frames = int(MIN_INTERLUDE_SEC / _FRAME_SEC)
    spans: list[tuple[int, int]] = []
    run_start: int | None = None
    for i in range(n_frames):
        if silent[i]:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None and i - run_start >= min_frames:
                spans.append((run_start, i))
            run_start = None
    if run_start is not None and n_frames - run_start >= min_frames:
        spans.append((run_start, n_frames))
    # Merge spans separated by less than the blip gap.
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and s - merged[-1][1] <= gap_frames:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    out: list[tuple[float, float]] = []
    for s, e in merged:
        start = s * _FRAME_SEC + time_offset_sec
        end = e * _FRAME_SEC + time_offset_sec
        if end - start >= MIN_INTERLUDE_SEC:
            out.append((start, end))
    return out


def borrow_interlude_lead(
    lead_events: tuple[RawNoteEvent, ...],
    accomp_voices: list[CleanedEvents],
    silent_spans: list[tuple[float, float]],
) -> tuple[list[RawNoteEvent], list[tuple[float, float]]]:
    """Borrow the accompaniment stem's top voice into the lead for each
    vocal-silent span.

    Per span the winning voice is the best-covering line with the
    highest median pitch — the articulated hook sits above the pads.
    Borrowed events are clipped to the span (edge guard inside), must
    stay above the lead-register floor, and may never overlap a real
    lead note — the monophonic contract of the lead staff is kept.

    Returns `(borrowed events, spans actually used)`.
    """
    borrowed: list[RawNoteEvent] = []
    used_spans: list[tuple[float, float]] = []
    lead = sorted(lead_events, key=lambda e: e.onset_sec)
    for span_start, span_end in silent_spans:
        lo = span_start + _EDGE_GUARD_SEC
        hi = span_end - _EDGE_GUARD_SEC
        if hi - lo < 1.0:
            continue
        best_voice: tuple[RawNoteEvent, ...] | None = None
        best_median = -1e9
        best_cov = 0.0
        for voice in accomp_voices:
            covered = 0.0
            pitches: list[float] = []
            for e in voice.events:
                c_lo = max(e.onset_sec, lo)
                c_hi = min(e.offset_sec, hi)
                if c_hi > c_lo:
                    covered += c_hi - c_lo
                    pitches.append(e.pitch_midi)
            cov = covered / (hi - lo)
            if cov < _MIN_SPAN_COVERAGE or not pitches:
                continue
            pitches.sort()
            median = pitches[len(pitches) // 2]
            # Among coverage-qualified voices the TOP line wins — a
            # sustained pad/bass out-covers every solo but sits below
            # the hook; on a pitch tie the fuller coverage takes it.
            if best_voice is None or median > best_median or (
                median == best_median and cov > best_cov
            ):
                best_voice = voice.events
                best_median = median
                best_cov = cov
        if best_voice is None:
            continue
        took = False
        for e in best_voice:
            if e.pitch_midi < _MIN_BORROW_MIDI:
                continue
            c_lo = max(e.onset_sec, lo)
            c_hi = min(e.offset_sec, hi)
            if c_hi - c_lo < _MIN_BORROW_DUR_SEC:
                continue
            inside = (c_hi - c_lo) / max(1e-6, e.offset_sec - e.onset_sec)
            if inside < _MIN_INSIDE_FRACTION:
                continue
            # Never overlap a real lead note — the vocal re-entering
            # wins, always.
            if any(le.onset_sec < c_hi and le.offset_sec > c_lo for le in lead):
                continue
            if any(b.onset_sec < c_hi and b.offset_sec > c_lo for b in borrowed):
                continue
            borrowed.append(
                replace(
                    e,
                    onset_sec=c_lo,
                    offset_sec=c_hi,
                    source="interlude-lead",
                )
            )
            took = True
        if took:
            used_spans.append((lo, hi))
    borrowed.sort(key=lambda e: (e.onset_sec, e.pitch_midi, str(e.id)))
    return borrowed, used_spans
