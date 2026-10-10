"""The ``transcription`` job: audio file -> canonical score (ENG-002).

Staged exactly as the UI progress contract (GUI_UX_SPEC §5,
``TRANSCRIPTION_STAGE_IDS``) — every stage emits a ``progress`` event
carrying ``stage`` so the transcribing screen never has to guess.
#385: stage transitions are honest boundaries — they carry NO job
fraction (the old fixed milestones 0.15/0.55/... read as real
percentages without measuring anything). Real measured work is
reported separately as ``step``/``totalSteps`` counts inside the
stage that owns the loop; the only ``progress`` fraction left is
``1.0`` on the terminal ``completed`` event.

    preparing_audio -> transcribing -> cleaning -> analyzing_rhythm
    -> quantizing -> building_score -> rendering

Cancellation is cooperative *between* stages (Basic Pitch inference is
one blocking ONNX call — ENGINE_RUNTIME_MATRIX.md). ``deadline_ms``
mirrors ``demoLongTask``: an engine-side wall-clock cap checked at the
same boundaries, ending in ``JOB_TIMEOUT``.

Failure mapping (all honest terminal ``failed`` events, never a crash):

* missing engine packages -> ``ENGINE_DEPENDENCY_MISSING``
* undecodable audio / backend error -> ``JOB_FAILED``
* zero pitched notes after cleaning -> ``NO_PITCHED_CONTENT``
  (retrying cannot help; the UI tailors its copy to this code)
"""

from __future__ import annotations

import contextlib
import hashlib
import math
import os
import tempfile
import threading
import time
import wave
from array import array
from collections.abc import Callable, Iterable
from dataclasses import replace
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import Any

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    ScoreRevisionId,
    TranscriptionRevisionId,
)
from hornscribe.domain.review import (
    IssueIdAllocator,
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.domain.score import (
    ChordSymbol,
    KeyChange,
    PitchSpace,
    QuantizedNote,
)
from hornscribe.export.musicxml import (
    export_b_flat_musicxml,
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)
from hornscribe.instruments.horn_f import HornRangeStatus, sounding_range_status
from hornscribe.notation.tone_spelling import fifths_at_beat, is_diatonic
from hornscribe.rhythm.issues import generate_review_issues
from hornscribe.rhythm.meter import MeterMap, MeterSegment, UnsupportedMeterError
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.timewarp import (
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)
from hornscribe.worker.protocol import (
    ERR_ENGINE_DEPENDENCY_MISSING,
    ERR_JOB_FAILED,
    ERR_JOB_TIMEOUT,
    ERR_NO_PITCHED_CONTENT,
)

from .backend import (
    BACKEND_ID,
    BACKEND_VERSION,
    MELODY_MAX_FREQUENCY_HZ,
    PYIN_BACKEND_ID,
    EngineDependencyError,
    load_mono_audio,
    new_transcription_revision,
    predict_note_events,
    predict_note_events_pyin,
    predict_note_events_rescued,
    require_module,
)
from .boundary import (
    OCTAVE_MIN_SPAN_SEC,
    boundary_flags,
    compute_envelopes,
    low_octave_evidence,
    low_octave_suspected,
    octave_prefers,
    seam_evidence,
)
from .chord import (
    LOW_CONFIDENCE as CHORD_LOW_CONFIDENCE,
)
from .chord import (
    LOW_MARGIN as CHORD_LOW_MARGIN,
)
from .chord import (
    ChordEstimate,
    diatonic_chords,
    estimate_chords,
)
from .clean import (
    MERGE_GAP_SEC,
    CleanedEvents,
    clean_monophonic,
    clip_to_range,
    split_voices,
)
from .key import analyze_key, key_uncertainty
from .leadvoice import lead_track_agreement
from .meter import estimate_meter
from .options import TranscriptionParams
from .scorebuild import build_score
from .swing import detect_swing
from .tempo import (
    estimate_tempo,
    pickup_uncertainty,
    tempo_map_from_estimate,
)
from .tempo_octave import detect_tempo_octave
from .vocal import (
    accompaniment_wav_for,
    demucs_available,
    demucs_weights_pending,
    vocal_wav,
    wav_rms,
)

JOB_KIND_TRANSCRIPTION = "transcription"

STAGES: tuple[str, ...] = (
    "preparing_audio",
    "transcribing",
    "cleaning",
    "analyzing_rhythm",
    "quantizing",
    "building_score",
    "rendering",
)

# Review thresholds (evidence-bearing, surfaced as issues — never silent
# corrections):
LOW_CONFIDENCE = 0.5
"""Backend amplitude below this flags ``low_model_confidence``."""
VERY_SHORT_SEC = 0.09
"""Surviving detections shorter than this flag ``very_short_detection``."""
MAX_EXTRA_ISSUES = 60
"""Cap on hand-built issues so a noisy take cannot flood the review UI."""
MAX_BOUNDARY_ISSUES = 20
"""Cap on boundary re-scoring flags (#423) - one suspicious edge per
hotspot is enough; a flickery take must not bury the queue."""
PITCH_DIP_MAX_SEC = 0.28
"""#264: a chromatic note must be SHORTER than this to count as a
possible tracker bin-snap — a deliberate semitone is normally held."""
MAX_CHORD_ISSUES = 10
"""Cap on chord-uncertainty segments (#419) - a harmonically muddy
piece flags its worst spans, not every bar."""

# ``auto`` texture: when the onset-clean pass still saw this many
# different-pitch overlaps (absolute floor + share of surviving events),
# the source is a mix, not a monophonic line — re-clean keeping the top
# voice so the melody survives instead of being clipped by accompaniment.
AUTO_TEXTURE_MIN_OVERLAPS = 4
AUTO_TEXTURE_OVERLAP_RATIO = 0.05

# #191: isolated-estimate RMS / source-slice RMS below which the lead
# counts as "buried" — the point where missed notes become plausible
# enough to tell the user about. A demucs stem carries near-true vocal
# energy, so a -9.5 dB lead (the #165 failure case) reads ~0.33 and
# the bar sits just under it; a center extraction attenuates even a
# healthy lead (side-channel loss + soft mask), so its bar is lower.
_LOW_LEAD_RMS_RATIO = {"demucs": 0.30}
_LOW_LEAD_RMS_RATIO_DEFAULT = 0.20

EventEmitter = Callable[..., None]
NoteBackend = Callable[[str], tuple[RawNoteEvent, ...]]
AudioLoader = Callable[[str], tuple[Any, int]]


# _track_beats: tempo-change handling (#93). librosa's global tracker
# forces ONE pulse for the whole file, so a mid-piece 100->140 step
# leaves the fast section anchored off-grid (the warp then converts
# score positions back to seconds ~60 ms wrong). The fix: segment the
# frame-level tempo curve into stable regions and re-track each with
# its own bpm.
# Plateau tolerance for the dyn curve: autocorr quantizes tempo to lag
# bins, so adjacent plateau levels sit ~4-5 % apart — 2 % splits each
# level (catching a continuous rit./accel. as a staircase) while in-
# plateau jitter stays inside its run (rubato-4-4).
_TEMPO_PLATEAU_BAND = 0.02
# Regions shorter than this merge into a neighbour -- a one-beat rit.
# is not a tempo section.
_TEMPO_REGION_MIN_SEC = 1.5
# Region tracking windows overlap the nominal bounds by this much so
# beats near the seam are still found; kept beats stay strictly inside.
_TEMPO_REGION_PAD_SEC = 0.6
# A gap wider than interval * this between region tracks means the
# boundary beat was lost -- refill it from the onset envelope.
_TEMPO_GAP_FILL_RATIO = 1.4
# A short region whose tempo sits within the plateau band of a
# small-integer metrical ratio of the dominant tempo is the autocorr
# reading a triplet/double pulse level, not a real tempo change --
# it is snapped to the dominant grid. Spans longer than this cap keep
# their own reading: a real double-time section holds for more than a
# few seconds.
_TEMPO_REGION_SNAP_MAX_SEC = 6.0
_TEMPO_METRICAL_RATIOS = (
    0.5,
    2.0 / 3.0,
    0.75,
    0.8,
    5.0 / 6.0,
    6.0 / 5.0,
    1.25,
    4.0 / 3.0,
    1.5,
    2.0,
)
# The tracker quantizes anchors to whole hop frames (~23 ms at
# 512/22050). On a regular pulse every anchor rounds to the SAME
# integer interval, so the measured tempo inherits a systematic
# bias (auto-3-4 read 129.2 bpm of a true 132 -- a 2 % drift that
# pushes every mapped onset off-grid). Peak refinement inside
# this radius recovers the fractional position.
_SUBFRAME_RADIUS_FRAMES = 2


def _refine_beat_frame(onset_env: Any, frame: int) -> float:
    """Fractional frame of the envelope peak near the tracked frame.

    Finds the strongest onset within +/-_SUBFRAME_RADIUS_FRAMES,
    interpolates the peak parabolically, then clamps the result to
    +-1 frame of the tracked position. The clamp matters: a 2-frame
    argmax jump alternating sign turns into interval sawtooth, and
    a 4-anchor measure slope swings ~5 % (tempo-step bench). Edge
    or too-short windows return the integer frame unchanged.
    """
    n = len(onset_env)
    lo = max(0, frame - _SUBFRAME_RADIUS_FRAMES)
    hi = min(n, frame + _SUBFRAME_RADIUS_FRAMES + 1)
    if hi - lo < 3:
        return float(frame)
    peak = lo + int(onset_env[lo:hi].argmax())
    refined = float(peak)
    if 0 < peak < n - 1:
        a = float(onset_env[peak - 1])
        b = float(onset_env[peak])
        c = float(onset_env[peak + 1])
        denom = a - 2.0 * b + c
        shift = 0.5 * (a - c) / denom if denom != 0.0 else 0.0
        refined += max(-1.0, min(1.0, shift))
    # Pull toward the peak but never leave the tracked frame's
    # neighbourhood -- the anchor moves at most +-1 frame.
    return float(frame) + max(-1.0, min(1.0, refined - float(frame)))


def _stem_analysis(stem_path: str | None) -> tuple[Any, int, Any]:
    """Decode a separation stem once for meter + chord evidence.

    Returns ``(samples, sample_rate, onset_env)``. The no_vocals
    accompaniment stem keeps the drums/bass/guitars that carry the
    downbeat structure a vocal line lacks (#233) and the harmony the
    chord map should read instead of the vocal-heavy full mix (#259);
    one decode feeds both plus the accompaniment octave evidence the
    caller already needed. ``(None, 0, None)`` when there is no stem
    or the audio stack is unavailable -- a silent miss costs the
    caller only the stem evidence pools, never the job.
    """
    if not stem_path:
        return None, 0, None
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
    except Exception:
        return None, 0, None
    try:
        y, sr = librosa.load(stem_path, sr=22050, mono=True)
    except Exception:
        return None, 0, None
    if y.size == 0:
        return None, 0, None
    return y, sr, librosa.onset.onset_strength(y=y, sr=sr)


def _drop_stem_bleed_lows(
    lead: CleanedEvents,
    accomp: list[CleanedEvents],
) -> CleanedEvents:
    """#236: drop lead notes that are accompaniment-stem bleed.

    Neural separation leaks stable bass/low f0 into the vocal stem;
    the lead tracker then notates phantom sub-bass melody (real
    capture: 22 of 36 notes >15 st under the melodic median matched
    the accompaniment stem pitch-for-pitch). A lead note below the
    duration-weighted melodic median minus the register band that is
    overlapped pitch-for-pitch by an accompaniment event is bleed --
    it already lives in the accompaniment part, so dropping it loses
    nothing. Vocal-stem-only lows stay: a real low vocal phrase must
    not be eaten by the register prior alone.
    """
    if not lead.events or not accomp:
        return lead
    pairs = sorted(
        (e.pitch_midi, max(e.offset_sec - e.onset_sec, 0.001))
        for e in lead.events
    )
    half = sum(w for _, w in pairs) / 2.0
    acc = 0.0
    median = pairs[-1][0]
    for p_, w in pairs:
        acc += w
        if acc >= half:
            median = p_
            break
    floor = median - 15.0
    accomp_events = [e for c in accomp for e in c.events]
    dropped_ids: set[RawNoteEventId] = set()

    def _is_bleed(e: RawNoteEvent) -> bool:
        return any(
            abs(a.pitch_midi - e.pitch_midi) <= 1.5
            and a.onset_sec < e.offset_sec
            and a.offset_sec > e.onset_sec
            for a in accomp_events
        )

    kept: list[RawNoteEvent] = []
    for e in lead.events:
        if e.pitch_midi < floor and _is_bleed(e):
            dropped_ids.add(e.id)
            continue
        kept.append(e)
    # Bleed spans interleave corroborated and uncorroborated frames --
    # a sub-floor fragment sitting inside a dropped bleed region is the
    # same physical event, not a coincidence the register prior missed.
    dropped_spans = [
        (e.onset_sec, e.offset_sec) for e in lead.events if e.id in dropped_ids
    ]
    still: list[RawNoteEvent] = []
    for e in kept:
        if e.pitch_midi < floor and any(
            e.onset_sec - b <= 0.6 and a - e.offset_sec <= 0.6
            for a, b in dropped_spans
        ):
            dropped_ids.add(e.id)
            continue
        # Below ~D2 a melodic line is never a usable lead vocal --
        # uncorroborated sub-bass frames are tracker artifacts.
        if e.pitch_midi < 38.0:
            dropped_ids.add(e.id)
            continue
        still.append(e)
    if not dropped_ids:
        return lead
    return replace(
        lead, events=tuple(still), bleed_dropped=len(dropped_ids)
    )


# #244: accompaniment-stem detections are flicker-heavy -- Basic
# Pitch hallucinates harmonic partials on the "other" stem, and the
# surviving part reads as wall-to-wall 16ths (reference mix: 1186 of
# 1497 events under 0.5 confidence, median flicker duration 151 ms vs
# 383 ms for the confident half). Confident detections always stay;
# mid-confidence notes earn a slot only by sustaining. The floor runs
# before voice splitting so the dropped flicker never votes for a
# voice and never gates a lead note as bleed.
_ACCOMP_CONF_KEEP = 0.50
_ACCOMP_CONF_SUSTAIN = 0.35
_ACCOMP_SUSTAIN_MIN_SEC = 0.30


def _accomp_confidence_floor(
    events: tuple[RawNoteEvent, ...],
) -> tuple[RawNoteEvent, ...]:
    """Drop short low-confidence flicker from accompaniment events.

    Keep when confident (>= _ACCOMP_CONF_KEEP), or when the note at
    least reaches the sustain floor AND holds long enough to be a real
    backing tone rather than a partial flicker.
    """
    kept = [
        e
        for e in events
        if float(e.confidence or 0.0) >= _ACCOMP_CONF_KEEP
        or (
            float(e.confidence or 0.0) >= _ACCOMP_CONF_SUSTAIN
            and float(e.offset_sec - e.onset_sec) >= _ACCOMP_SUSTAIN_MIN_SEC
        )
    ]
    return tuple(kept)


def _track_beats(samples: Any, sample_rate: int) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """Beat times + onset strength sampled at each beat (librosa).

    Shared by the meter estimator (needs strengths at beats) and the
    tempo warp (needs the beat times themselves). A failed or empty
    track returns empty tuples — callers degrade to the 4/4 default.
    When the frame-level tempo curve shows more than one stable
    region, each region is re-tracked at its own tempo so a mid-piece
    tempo step stays on-grid (#93).
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency

    onset_env = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    _tempo, beat_frames = librosa.beat.beat_track(
        y=samples, sr=sample_rate, onset_envelope=onset_env, units="frames"
    )

    def collect(frames: Any) -> tuple[list[float], list[float]]:
        times: list[float] = []
        strengths: list[float] = []
        for frame in frames:
            refined = _refine_beat_frame(onset_env, int(frame))
            ft = float(librosa.frames_to_time(refined, sr=sample_rate))
            if times and ft <= times[-1]:
                continue
            s_idx = int(round(refined))
            strength = float(onset_env[s_idx]) if 0 <= s_idx < len(onset_env) else 0.0
            times.append(ft)
            strengths.append(strength)
        return times, strengths

    times, strengths = collect(beat_frames)

    regions = _tempo_regions(onset_env, sample_rate)
    if len(regions) < 2 or not times:
        return tuple(times), tuple(strengths)

    duration = float(len(samples)) / sample_rate if len(samples) else 0.0
    merged: list[tuple[float, int]] = []
    region_intervals: list[float] = []
    for r_i, (lo, hi, bpm) in enumerate(regions):
        pad_lo = max(0.0, lo - _TEMPO_REGION_PAD_SEC)
        pad_hi = min(duration, hi + _TEMPO_REGION_PAD_SEC)
        f0 = int(librosa.time_to_frames(pad_lo, sr=sample_rate))
        f1 = int(librosa.time_to_frames(pad_hi, sr=sample_rate)) + 1
        seg = onset_env[f0:f1]
        if len(seg) < 4:
            continue
        _seg_tempo, seg_frames = librosa.beat.beat_track(
            onset_envelope=seg,
            sr=sample_rate,
            units="frames",
            bpm=float(bpm),
        )
        seg_times, _seg_strengths = collect(seg_frames + f0)
        region_intervals.append(60.0 / float(bpm) if bpm > 0 else 0.5)
        for t in seg_times:
            if lo <= t < hi:
                merged.append((t, r_i))
    merged.sort()

    if len(merged) < 2:
        return tuple(times), tuple(strengths)

    # Refill a beat the per-region DP dropped -- at a seam or inside a
    # region. The expected interval is the region being ENTERED, so a
    # fast region's short interval never judges the slow region's
    # honest gaps (the first version filled those with phantom beats).
    filled: list[tuple[float, int]] = []
    for i, (t, r_i) in enumerate(merged):
        if i:
            prev_t = filled[-1][0]
            interval = region_intervals[r_i]
            while t - prev_t > interval * _TEMPO_GAP_FILL_RATIO:
                predicted = prev_t + interval
                f_lo = int(
                    librosa.time_to_frames(
                        max(prev_t + 0.05, predicted - 0.2 * interval),
                        sr=sample_rate,
                    )
                )
                f_hi = int(
                    librosa.time_to_frames(
                        min(t - 0.05, predicted + 0.2 * interval),
                        sr=sample_rate,
                    )
                )
                if not (0 <= f_lo < f_hi <= len(onset_env)):
                    break
                peak = f_lo + int(onset_env[f_lo:f_hi].argmax())
                if float(onset_env[peak]) <= 0:
                    break
                prev_t = float(
                    librosa.frames_to_time(_refine_beat_frame(onset_env, peak), sr=sample_rate)
                )
                filled.append((prev_t, r_i))
        filled.append((t, r_i))

    # Onset-strength samples must stay index-parallel with the merged
    # beats (the tempo estimate consumes them pairwise).
    out_times: list[float] = []
    out_strengths: list[float] = []
    for t, _r in filled:
        if out_times and t <= out_times[-1]:
            continue
        idx = int(librosa.time_to_frames(t, sr=sample_rate))
        strength = float(onset_env[idx]) if 0 <= idx < len(onset_env) else 0.0
        out_times.append(t)
        out_strengths.append(strength)
    return tuple(out_times), tuple(out_strengths)


def _tempo_regions(onset_env: Any, sample_rate: int) -> list[tuple[float, float, float]]:
    """Stable-tempo regions from the frame-level tempo curve.

    Returns (start_sec, end_sec, mean_bpm) per region in order. The
    curve comes from librosa's autocorr tracker; the grouping itself is
    pure so the unit tests drive it without a librosa install.
    Regions shorter than _TEMPO_REGION_MIN_SEC fold into the tempo-
    nearer neighbour; fewer than two survivors returns [] (the caller
    keeps the single global track).
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    dyn = np.asarray(
        librosa.feature.tempo(onset_envelope=onset_env, sr=sample_rate, aggregate=None),
        dtype=float,
    )
    dyn = dyn[np.isfinite(dyn) & (dyn > 0)]
    return _tempo_regions_from_dyn(dyn, 512.0 / float(sample_rate))


def _tempo_regions_from_dyn(dyn: Any, frame_sec: float) -> list[tuple[float, float, float]]:
    """Plateau-group a frame-level tempo curve into stable regions.

    The autocorr tempo curve is piecewise-constant (one lag bin per
    run). Grouping by the run's own mean — not the whole region's
    running median — lets a continuous rit./accel. surface as a
    staircase of regions to re-track individually, instead of
    collapsing to a single averaged tempo the per-region DP cannot
    follow (rubato-4-4: a 120->90 drift previously read as one 112-bpm
    region and the tracker lost the first five beats).
    """
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    if len(dyn) < 4:
        return []

    # Regions live in FRAME units until the final report: fold weights
    # need true durations in frames, and the median recompute slices
    # dyn by index.
    regions: list[list[float]] = []
    run = [float(dyn[0])]
    start = 0
    for i in range(1, len(dyn)):
        mean = float(np.mean(run))
        v = float(dyn[i])
        if mean > 0 and abs(v - mean) / mean > _TEMPO_PLATEAU_BAND:
            regions.append([float(start), float(i), mean])
            run = [v]
            start = i
        else:
            run.append(v)
    regions.append([float(start), float(len(dyn)), float(np.mean(run))])

    # Fold too-short regions into the tempo-nearer neighbour, weighting
    # each side by its duration. The earlier unweighted mean let a
    # single-frame autocorr blip halve a 100 s plateau's tempo: 152
    # scattered 95.7 bpm triplet-level flickers dragged 0-101 s of a
    # steady 143.5 bpm song down to a fictitious 119.6 bpm region, and
    # the region re-track then locked the wrong pulse for half the
    # piece (milk-crescendo).
    min_frames = max(1, int(round(_TEMPO_REGION_MIN_SEC / frame_sec)))
    changed = True
    while changed and len(regions) > 1:
        changed = False
        for i, r in enumerate(regions):
            span = r[1] - r[0]
            if span >= min_frames:
                continue
            left = regions[i - 1] if i > 0 else None
            right = regions[i + 1] if i + 1 < len(regions) else None
            if left is None and right is None:
                break
            merge_left = left is not None and (
                right is None or abs(left[2] - r[2]) <= abs(right[2] - r[2])
            )
            target = left if merge_left else right
            if target is None:
                break
            tn = target[1] - target[0]
            target[2] = (target[2] * tn + r[2] * span) / (tn + span)
            if merge_left:
                target[1] = r[1]
            else:
                target[0] = r[0]
            regions.pop(i)
            changed = True
            break
    if len(regions) < 2:
        return []

    # A region that absorbed scattered blips still carries the muddled
    # running mean; the member-frame median is the tempo to prime the
    # per-region DP with.
    for r in regions:
        seg = dyn[int(r[0]) : int(r[1])]
        if len(seg):
            r[2] = float(np.median(seg))

    # Snap short metrical-ratio regions to the dominant grid (see the
    # constants above).
    dominant = float(np.median(dyn))
    for r in regions:
        if (r[1] - r[0]) * frame_sec > _TEMPO_REGION_SNAP_MAX_SEC:
            continue
        for ratio in _TEMPO_METRICAL_RATIOS:
            target = dominant * ratio
            if (
                target > 0
                and abs(r[2] - target) / target <= _TEMPO_PLATEAU_BAND
            ):
                r[2] = dominant
                break

    # Neighbours that landed on the same tempo (post-snap) are one
    # region; splitting would re-track an identical pulse twice and
    # risk a seam glitch at the boundary.
    merged: list[list[float]] = [regions[0]]
    for r in regions[1:]:
        last = merged[-1]
        if abs(r[2] - last[2]) / last[2] <= _TEMPO_PLATEAU_BAND:
            ln = last[1] - last[0]
            rn = r[1] - r[0]
            last[2] = (last[2] * ln + r[2] * rn) / (ln + rn)
            last[1] = r[1]
        else:
            merged.append(r)
    if len(merged) < 2:
        return []
    return [(r[0] * frame_sec, r[1] * frame_sec, r[2]) for r in merged]


def _event_accents(
    events: Iterable[RawNoteEvent],
    samples: Any,
    sample_rate: int,
    time_offset_sec: float = 0.0,
) -> tuple[tuple[float, float], ...]:
    """(onset_sec, post-onset RMS) per event -- meter accent evidence.

    The tracker's onset envelope is too noisy to read performed
    accents (#87), but the audio energy in a short window after each
    detected onset tracks them closely. Pure-Python RMS keeps this a
    no-op on engines without numpy.

    time_offset_sec maps absolute event times into the analysis
    buffer — a selection slice or an isolation stem both start at
    their span's source offset, not at source t=0 (#256).
    """
    window = int(0.12 * sample_rate)
    out: list[tuple[float, float]] = []
    n = len(samples)
    for ev in events:
        i0 = max(0, int((ev.onset_sec - time_offset_sec) * sample_rate))
        i1 = min(n, i0 + window)
        if i1 - i0 < 8:
            continue
        seg = samples[i0:i1]
        ss = sum(float(v) * float(v) for v in seg)
        out.append((float(ev.onset_sec), math.sqrt(ss / len(seg))))
    out.sort(key=lambda p: p[0])
    return tuple(out)


def _warp_evidence(warp: TimeWarp) -> dict[str, Any]:
    """Serialize the seconds->ql warp for later requantization (#226).

    A beat-map warp stores its anchors (absolute source seconds ->
    score position); a fixed-BPM warp stores bpm/zero_sec. Rebuilding
    the warp from this evidence reproduces the exact grid the original
    quantization ran on.
    """
    if warp.mode is TimeWarpMode.BEAT_MAP and warp.beat_map is not None:
        return {
            "kind": "beatMap",
            "anchors": [
                {
                    "timeSec": a.time_sec,
                    "posQl": str(a.score_pos_ql),
                }
                for a in warp.beat_map.anchors
            ],
        }
    return {
        "kind": "fixedBpm",
        "bpm": warp.bpm,
        "zeroSec": warp.zero_sec,
    }


def _shift_event_times(
    events: tuple[RawNoteEvent, ...], offset_sec: float
) -> tuple[RawNoteEvent, ...]:
    """Translate slice-relative event times to absolute source seconds.

    #229: a selection job stages only the chosen range for the backend,
    so every timestamp it emits is relative to the slice start. The
    downstream stages (clip_to_range, review seek targets, project
    provenance) all speak absolute source seconds — shift once here.
    """
    if offset_sec == 0.0:
        return events
    return tuple(
        replace(
            ev,
            onset_sec=ev.onset_sec + offset_sec,
            offset_sec=ev.offset_sec + offset_sec,
            pitch_bends=tuple(replace(b, time_sec=b.time_sec + offset_sec) for b in ev.pitch_bends),
        )
        for ev in events
    )


def _samples_rms(samples: Any) -> float:
    """RMS of a decoded mono buffer (#191) — numpy lazily, matching the
    module's optional-dependency convention."""
    import numpy as np  # noqa: PLC0415

    arr = np.asarray(samples, dtype=np.float64)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(arr * arr)))


def _stage_selection_wav(samples: Any, sample_rate: int) -> str | None:
    """Write *samples* to a temp PCM16 WAV; return its path or None.

    #229: both backends take a file path, so a sliced selection is
    staged on disk. The caller deletes the file after inference.
    """
    try:
        pcm = array(
            "h",
            (max(-32768, min(32767, int(round(float(v) * 32768.0)))) for v in samples),
        )
        if pcm.itemsize != 2:  # platform 'h' must be 16-bit for WAV
            return None
        fd, path = tempfile.mkstemp(prefix="hornscribe-sel-", suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as handle, wave.open(handle, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                wav.writeframes(pcm.tobytes())
        except BaseException:
            with contextlib.suppress(OSError):
                os.close(fd)
            with contextlib.suppress(OSError):
                os.unlink(path)
            return None
        return path
    except (OSError, ValueError, TypeError):
        return None


def _sha256_file(path: str) -> str | None:
    """Streaming SHA-256 for the project sourceAudio.contentHash contract.

    Returns None when the file cannot be read — provenance is
    best-effort, never a reason to fail the job.
    """
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _extra_issues(
    built_notes: tuple[QuantizedNote, ...],
    confidence: dict[ScoreNoteId, float],
    onsets_sec: dict[ScoreNoteId, float],
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
    score_revision: ScoreRevisionId,
) -> list[ReviewIssue]:
    """Confidence/range/duration issues the quantizer cannot see.

    ``built_notes`` are the canonical QuantizedNote rows; ids are the
    ``sn-*`` values the review workspace highlights.
    """
    issues: list[ReviewIssue] = []
    for note in built_notes:
        conf = confidence.get(note.id)
        onset = onsets_sec.get(note.id, 0.0)
        rng = TimeRange(start_sec=onset, end_sec=onset + 0.05)
        if conf is not None and conf < LOW_CONFIDENCE:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.LOW_MODEL_CONFIDENCE,
                    severity=(Severity.WARNING if conf < 0.3 else Severity.CAUTION),
                    evidence={"modelConfidence": round(conf, 3)},
                )
            )
        status = sounding_range_status(note.pitch_midi)
        if status is not HornRangeStatus.NORMAL:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.OUTSIDE_PREFERRED_HORN_RANGE,
                    severity=(
                        Severity.WARNING if status is HornRangeStatus.EXTREME else Severity.CAUTION
                    ),
                    evidence={"pitchMidi": note.pitch_midi},
                )
            )
        raw_spans = [
            event_by_id[e].offset_sec - event_by_id[e].onset_sec
            for e in note.source_event_ids
            if e in event_by_id
        ]
        if raw_spans and min(raw_spans) < VERY_SHORT_SEC:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.VERY_SHORT_DETECTION,
                    severity=Severity.INFO,
                    evidence={},
                )
            )
    # #272: return every detected issue; the caller applies the
    # severity-priority cap so a flood of early low-severity notes
    # cannot silently drop later warnings.
    return issues


# #166: chromatic pitch classes whose enharmonic spelling the key cannot
# decide — one issue per pitch class, capped so a chromatic-heavy piece
# cannot flood the review list.
_MAX_SPELLING_ISSUES = 8
_MAX_SPELLING_NOTE_IDS = 6


def _spelling_issues(
    payload_notes: tuple[QuantizedNote, ...],
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    onsets_sec: dict[ScoreNoteId, float],
    score_revision: ScoreRevisionId,
    chord_map: tuple[ChordEstimate, ...] = (),
    prefer_flats: bool = False,
) -> list[ReviewIssue]:
    """Flag chromatic notes whose enharmonic spelling is ambiguous (#166).

    The notation layer already spells every note against the active key
    (#165); a pitch class outside that key has two defensible spellings
    (raised-below vs lowered-above), so the note is surfaced for review
    rather than guessed silently — the contract clean.py documents.
    Grouped by pitch class so a repeated chromatic tone raises one
    issue, not one per occurrence.
    """
    by_pc: dict[int, list[QuantizedNote]] = {}
    for n in payload_notes:
        fifths = fifths_at_beat(head_fifths, key_changes, n.start_beat)
        if not is_diatonic(n.pitch_midi, fifths):
            by_pc.setdefault(n.pitch_midi % 12, []).append(n)
    issues: list[ReviewIssue] = []
    for pc, notes in sorted(by_pc.items()):
        if len(issues) >= _MAX_SPELLING_ISSUES:
            break
        first = min(notes, key=lambda n: n.start_beat)
        onset = onsets_sec.get(first.id, 0.0)
        # #419: the chord sounding under this note is the context
        # the reviewer needs - is the chromatic tone a chord tone
        # (secondary dominant, blues) or a passing artifact?
        est = next(
            (c for c in chord_map if c.start_sec <= onset < c.end_sec),
            None,
        )
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=tuple(n.id for n in notes[:_MAX_SPELLING_NOTE_IDS]),
                time_range=TimeRange(start_sec=onset, end_sec=onset + 0.05),
                reason=ReviewReason.PITCH_SPELLING_AMBIGUOUS,
                severity=Severity.INFO,
                evidence={
                    "pitchClass": pc,
                    "occurrences": len(notes),
                    **(
                        {
                            "localChord": est.label(prefer_flats),
                            "chordTone": pc in est.chord_tones(),
                        }
                        if est is not None
                        else {}
                    ),
                },
            )
        )
    return issues


def _boundary_issues(
    samples: Any,
    sample_rate: int,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
    warp: TimeWarp,
    beat_ql: Fraction,
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
) -> list[ReviewIssue]:
    """Audio-evidence second opinion on note edges (#423).

    boundary_flags re-scores every cleaned edge per voice; this maps
    the survivors onto canonical notes so the suggestion is a real
    score edit, not a raw-event hint. A flag only becomes an issue
    when the matching one-click fix can actually apply:

    - ``merge``     - both events must map to different canonical
      notes in the same part, same written pitch, exactly adjacent
      (``a.end_beat == b.start_beat``) so ``mergeNotes`` applies.
    - ``split``     - the event must map to a canonical note whose
      beat span strictly contains the flagged second, so ``splitNote``
      lands inside the note (the beat rides along as
      ``suggestedSplitBeat``).
    - ``uncertain`` - no fix is suggested; both sides are attached
      for highlighting and the user decides.

    Flags whose events quantized away (or onto the same note, or a
    deleted note) are dropped - the score no longer has that edge.
    """
    canon_by_event: dict[RawNoteEventId, QuantizedNote] = {}
    part_of: dict[ScoreNoteId, int] = {}
    for pi, part in enumerate(parts):
        for n in part.notes:
            part_of[n.id] = pi
            for e in n.source_event_ids:
                canon_by_event.setdefault(e, n)
    issues: list[ReviewIssue] = []
    for c in cleaneds:
        for flag in boundary_flags(samples, sample_rate, c.events, time_offset_sec=time_offset_sec):
            note_ids: list[ScoreNoteId] = []
            evidence: dict[str, Any] = {
                "suggestedKind": flag.kind,
                "boundarySec": round(flag.boundary_sec, 3),
                "boundaryScore": flag.score,
                **flag.detail,
            }
            if flag.kind == "split":
                n = canon_by_event.get(flag.event_ids[0])
                if n is None or n.deleted:
                    continue
                split_beat = warp.seconds_to_ql(flag.boundary_sec) / beat_ql
                if not (n.start_beat < split_beat < n.end_beat):
                    continue
                evidence["suggestedSplitBeat"] = str(split_beat)
                note_ids.append(n.id)
                severity = Severity.CAUTION
            else:
                a = canon_by_event.get(flag.event_ids[0])
                b = canon_by_event.get(flag.event_ids[1])
                if a is None or b is None or a.deleted or b.deleted:
                    continue
                if a.id == b.id:
                    continue  # both events already fed one canonical note
                if flag.kind == "merge" and (
                    part_of.get(a.id) != part_of.get(b.id)
                    or a.pitch_midi != b.pitch_midi
                    or a.end_beat != b.start_beat
                ):
                    continue
                severity = Severity.CAUTION if flag.kind == "merge" else Severity.INFO
                note_ids.extend((a.id, b.id))
            ev_a = event_by_id.get(flag.event_ids[0])
            ev_b = event_by_id.get(flag.event_ids[1]) if len(flag.event_ids) > 1 else None
            if ev_a is not None and ev_b is not None:
                lo, hi = ev_a.offset_sec, ev_b.onset_sec
            else:
                lo = flag.boundary_sec - 0.1
                hi = flag.boundary_sec + 0.1
            if hi - lo < 0.04:
                mid = 0.5 * (lo + hi)
                lo, hi = mid - 0.02, mid + 0.02
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=tuple(note_ids),
                    time_range=TimeRange(start_sec=max(0.0, lo), end_sec=hi),
                    reason=ReviewReason.BOUNDARY_UNCERTAIN,
                    severity=severity,
                    evidence=evidence,
                )
            )
    _rank = {Severity.CAUTION: 0, Severity.INFO: 1}
    issues.sort(key=lambda i: (_rank.get(i.severity, 2), i.time_range.start_sec))
    return issues[:MAX_BOUNDARY_ISSUES]


def _span_pitch_median(
    events: tuple[RawNoteEvent, ...],
    lo_sec: float,
    hi_sec: float,
) -> float | None:
    """Span-overlap-weighted median pitch of events covering [lo, hi].

    Robust to flicker: an octave jump inside a note only moves the
    median when it persists for most of the span — exactly the
    signal a real octave disagreement produces.
    """
    vals: list[tuple[float, float]] = []
    for e in events:
        w = min(hi_sec, e.offset_sec) - max(lo_sec, e.onset_sec)
        if w > 0.02:
            vals.append((w, e.pitch_midi))
    if not vals:
        return None
    vals.sort(key=lambda t: t[1])
    total = sum(w for w, _ in vals)
    acc = 0.0
    for w, p in vals:
        acc += w
        if acc >= total / 2.0:
            return p
    return vals[-1][1]


# The two tracks must disagree by roughly an octave — a chord-tone
# gap (3-7st) is a different question.
ARBITER_OCTAVE_MIN_ST = 10.5
ARBITER_OCTAVE_MAX_ST = 13.5


def _octave_issues(
    samples: Any,
    sample_rate: int,
    warp: Any,
    beat_ql: Fraction,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
    arbiter_events: tuple[RawNoteEvent, ...] = (),
    arbiter_backend: str = "",
) -> list[ReviewIssue]:
    """Low-octave audit (#264) — flag-only second opinion on pitch.

    A tracker that locks onto the 2nd harmonic writes the note an
    octave too high. Two independent readings must agree before a
    flag is raised: the spectrum carries energy at f(P-12) AND at
    1.5*f(P) (slots the written pitch's own harmonics never fill),
    AND the waveform is periodic at the low octave's lag while NOT
    at the written pitch's — a true low note's odd harmonics
    decorrelate every half-period, so the written pitch cannot
    explain its own waveform.

    The measurement spans the SCORE NOTE's written extent — its beat
    span pushed back through the warp into audio seconds — not any
    raw event's span. A detection shorter than the written note
    (an early release, a clipped tail) can sit under the FFT floor
    even on a long written note, and a raw-event audit silently
    skipped those; on the reference mix the atom-level reading
    flagged one suspect where the note-level one finds eight. The
    written pitch is what the flag describes, so it is also what
    the spectrum is asked about — a note whose pitch a repair
    already corrected is no longer judged on the stale raw pitch.

    Only notes whose source events were detected on THIS buffer are
    audited: the accompaniment staff's notes would read lead-stem
    energy (or its absence) as evidence about pitches that were
    never measured there. Octave truth on the accompaniment stem is
    a different, polyphonic-instrument question (#264).

    Flag-only by design: an octave-doubled backing voice is
    spectrally indistinguishable from a tracking error, so the score
    keeps the detected pitch and the issue carries the suggested
    -12 fix the review bar can apply after the user listens.

    Deleted notes are skipped — the score no longer carries that
    pitch.
    """
    audited_events: set[RawNoteEventId] = {
        ev.id for c in cleaneds for ev in c.events
    }
    issues: list[ReviewIssue] = []
    flagged: set[ScoreNoteId] = set()
    for part in parts:
        for n in part.notes:
            if n.deleted:
                continue
            if not any(e in audited_events for e in n.source_event_ids):
                continue
            lo_sec = warp.ql_to_seconds(n.start_beat * beat_ql)
            hi_sec = warp.ql_to_seconds(n.end_beat * beat_ql)
            evidence = low_octave_evidence(
                samples,
                sample_rate,
                lo_sec,
                hi_sec,
                n.pitch_midi,
                time_offset_sec=time_offset_sec,
            )
            if not low_octave_suspected(evidence):
                continue
            flagged.add(n.id)
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(n.id,),
                    time_range=TimeRange(start_sec=lo_sec, end_sec=hi_sec),
                    reason=ReviewReason.OCTAVE_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "pitchMidi": int(n.pitch_midi),
                        "suggestedMidi": int(n.pitch_midi) - 12,
                        "lowFundRatio": round(evidence.low_fund_ratio, 3),
                        "oddHarmonicRatio": round(evidence.odd_harm_ratio, 3),
                        "lowPeriodScore": round(evidence.low_period_score, 3),
                        "highPeriodScore": round(evidence.high_period_score, 3),
                    },
                )
            )
    # #80: second-track arbitration — the lead gate's losing engine is
    # an independent pitch read on the same stem buffer, already paid
    # for. A ~±12st disagreement over the note's own span means one
    # engine tracked an octave error; the note's spectrum arbitrates
    # (fundamental-band dominance), so only a confirmed disagreement
    # flags — a bare disagreement with no spectral support stays
    # silent, and a note the spectral audit already flagged is not
    # double-counted.
    if arbiter_events:
        for part in parts:
            for n in part.notes:
                if n.deleted or n.id in flagged:
                    continue
                if not any(e in audited_events for e in n.source_event_ids):
                    continue
                lo_sec = warp.ql_to_seconds(n.start_beat * beat_ql)
                hi_sec = warp.ql_to_seconds(n.end_beat * beat_ql)
                median = _span_pitch_median(arbiter_events, lo_sec, hi_sec)
                if median is None:
                    continue
                diff = median - n.pitch_midi
                if not (
                    ARBITER_OCTAVE_MIN_ST
                    <= abs(diff)
                    <= ARBITER_OCTAVE_MAX_ST
                ):
                    continue
                suggested = int(n.pitch_midi) + (12 if diff > 0 else -12)
                if not octave_prefers(
                    samples,
                    sample_rate,
                    lo_sec,
                    hi_sec,
                    n.pitch_midi,
                    float(suggested),
                    time_offset_sec=time_offset_sec,
                ):
                    continue  # spectrum keeps the written pitch
                issues.append(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(n.id,),
                        time_range=TimeRange(start_sec=lo_sec, end_sec=hi_sec),
                        reason=ReviewReason.OCTAVE_UNCERTAIN,
                        severity=Severity.CAUTION,
                        evidence={
                            "pitchMidi": int(n.pitch_midi),
                            "suggestedMidi": suggested,
                            # The second engine's own reading — the
                            # disagreement the flag describes.
                            "arbiterMidi": round(median, 1),
                            "arbiterBackend": arbiter_backend or None,
                        },
                    ),
                )
    issues.sort(key=lambda i: i.time_range.start_sec)
    return issues[:MAX_BOUNDARY_ISSUES]


def _pitch_dip_issues(
    samples: Any,
    sample_rate: int,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
) -> list[ReviewIssue]:
    """Isolated semitone dips (#264) — flag-only second opinion.

    A sub-280 ms note exactly one semitone off a diatonic neighbour,
    chromatic under the local key while the line around it stays
    diatonic, is far more often a tracker bin-snap than a sung
    semitone — a deliberate passing tone is normally longer or part
    of a repeated chromatic figure. The suggestion is the diatonic
    neighbour it probably belongs to; when the span allows it, the
    note's own spectrum arbitrates (suggested band dominant = the
    dip is audio-verified).

    Flag-only: chromatic passing tones do exist, so the score keeps
    the detected pitch and the issue offers the semitone fix after
    the user listens.
    """
    canon_by_event: dict[RawNoteEventId, QuantizedNote] = {}
    for part in parts:
        for n in part.notes:
            for e in n.source_event_ids:
                canon_by_event.setdefault(e, n)
    issues: list[ReviewIssue] = []
    seen: set[ScoreNoteId] = set()
    for c in cleaneds:
        events = c.events
        for i, ev in enumerate(events):
            span = ev.offset_sec - ev.onset_sec
            if span <= 0.0 or span >= PITCH_DIP_MAX_SEC:
                continue
            n = canon_by_event.get(ev.id)
            if n is None or n.deleted or n.id in seen:
                continue
            fifths = fifths_at_beat(head_fifths, key_changes, n.start_beat)
            pitch = int(round(ev.pitch_midi))
            if is_diatonic(pitch, fifths):
                continue  # not chromatic — not a dip suspect
            prev_ev = events[i - 1] if i > 0 else None
            next_ev = events[i + 1] if i + 1 < len(events) else None
            prev_midi = (
                int(round(prev_ev.pitch_midi)) if prev_ev is not None else None
            )
            next_midi = (
                int(round(next_ev.pitch_midi)) if next_ev is not None else None
            )
            if prev_midi is not None and not is_diatonic(prev_midi, fifths):
                continue  # inside a chromatic passage
            if next_midi is not None and not is_diatonic(next_midi, fifths):
                continue
            suggested: int | None = None
            if prev_midi is not None and abs(pitch - prev_midi) == 1:
                suggested = prev_midi
            elif next_midi is not None and abs(pitch - next_midi) == 1:
                suggested = next_midi
            if suggested is None:
                continue  # a chromatic note unrelated to its neighbours
            spectral: bool | None = None
            if span >= OCTAVE_MIN_SPAN_SEC:
                spectral = octave_prefers(
                    samples,
                    sample_rate,
                    ev.onset_sec,
                    ev.offset_sec,
                    ev.pitch_midi,
                    float(suggested),
                    time_offset_sec=time_offset_sec,
                )
            seen.add(n.id)
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(n.id,),
                    time_range=TimeRange(
                        start_sec=ev.onset_sec, end_sec=ev.offset_sec
                    ),
                    reason=ReviewReason.PITCH_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "pitchMidi": pitch,
                        "suggestedMidi": suggested,
                        "prevMidi": prev_midi,
                        "nextMidi": next_midi,
                        **(
                            {"spectralSupport": spectral}
                            if spectral is not None
                            else {}
                        ),
                    },
                )
            )
    issues.sort(key=lambda i: i.time_range.start_sec)
    return issues[:MAX_BOUNDARY_ISSUES]


def _chord_issues(
    chord_map: tuple[ChordEstimate, ...],
    canonical_notes: tuple[QuantizedNote, ...],
    warp: TimeWarp,
    beat_ql: Fraction,
    score_revision: ScoreRevisionId,
    prefer_flats: bool,
) -> list[ReviewIssue]:
    """Low-confidence chord segments as review issues (#419).

    A segment is flagged when the best template explains the chroma
    weakly (``confidence < LOW_CONFIDENCE``) or two candidates are
    nearly tied (``margin < LOW_MARGIN``). Segments with no note
    onsets are skipped - interludes and tails carry no spelling or
    rhythm decisions for the chord context to inform.
    """
    issues: list[ReviewIssue] = []
    note_secs = sorted(
        (
            warp.ql_to_seconds(n.start_beat * beat_ql),
            n.id,
        )
        for n in canonical_notes
        if not n.deleted
    )
    for est in chord_map:
        if est.confidence >= CHORD_LOW_CONFIDENCE and (est.margin >= CHORD_LOW_MARGIN):
            continue
        ids = tuple(nid for sec, nid in note_secs if est.start_sec <= sec < est.end_sec)[:6]
        if not ids:
            continue
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=ids,
                time_range=TimeRange(
                    start_sec=max(0.0, est.start_sec),
                    end_sec=est.end_sec,
                ),
                reason=ReviewReason.CHORD_UNCERTAIN,
                severity=Severity.INFO,
                evidence={
                    "suggestedChord": est.label(prefer_flats),
                    "runnerUpChord": est.runner_up,
                    "chordConfidence": round(est.confidence, 3),
                    "chordMargin": round(est.margin, 3),
                },
            )
        )
        if len(issues) >= MAX_CHORD_ISSUES:
            break
    return issues


def _merged_chord_dicts(
    chord_map: tuple[ChordEstimate, ...], prefer_flats: bool
) -> list[dict[str, Any]]:
    """Consecutive same-chord segments merged into readable spans -
    the meta progression reads "C | G | C", not sixteen half-bars."""
    out: list[dict[str, Any]] = []
    for est in chord_map:
        if out and out[-1]["rootPc"] == est.root_pc and out[-1]["quality"] == est.quality:
            out[-1]["endSec"] = round(est.end_sec, 3)
            out[-1]["confidence"] = round(min(out[-1]["confidence"], est.confidence), 3)
            continue
        out.append(est.to_dict(prefer_flats))
    return out


# pYIN is adopted on an isolated-vocal estimate only when its track
# agrees with the Basic Pitch melody line on most of its note-time —
# 60% sits far above the ~0 a tracker earns while following a
# bleed-dominated bass/pad line, and below the ~90% a genuinely
# shared vocal line scores.
LEAD_GATE_MIN_AGREEMENT = 0.6


def _lead_track_gate(
    backend_path: str,
    *,
    bp_revision: TranscriptionRevisionId,
    pyin_revision: TranscriptionRevisionId,
    hz_kwargs: dict[str, Any],
    prefer: str,
) -> tuple[bool, float, tuple[RawNoteEvent, ...], tuple[RawNoteEvent, ...]]:
    """Run pYIN and rescued Basic Pitch on the isolated estimate and
    return ``(adopt_pyin, agreement, winner, loser)`` (#165, #80).

    The losing track is returned too - it is an independent pitch
    opinion the gate already paid for, and the octave audit uses it
    as the disagreement arbiter (two engines an octave apart on the
    same span is exactly the case that needs a flag).

    #316 resolved pYIN unconditionally for an isolated vocal — the
    estimate was assumed monophonic.  In practice the centre
    extractor can leave a bass/pad line louder than the buried lead,
    and the tracker then follows that line end-to-end while the lead
    goes unheard (very-quiet-lead: pYIN scored 0/38 where Basic
    Pitch's melody arbitration found 35 of 38).  The gate adopts
    pYIN only when its track substantially agrees with the line
    Basic Pitch calls the melody — on a clean estimate both engines
    hear the vocal and pYIN's superior frame tracking wins
    legitimately; on a bleed-heavy one the polyphonic model's
    arbitration survives instead.
    """
    bp_events = predict_note_events_rescued(backend_path, revision=bp_revision, **hz_kwargs)
    pyin_events = predict_note_events_pyin(backend_path, revision=pyin_revision, **hz_kwargs)
    # The arbitration line mirrors the downstream clean — the gate
    # asks "did the tracker follow THE LINE", so the comparison
    # line is built with the texture's own overlap rule.
    bp_line = clean_monophonic(bp_events, merge_gap_sec=MERGE_GAP_SEC, prefer=prefer).events
    agreement = lead_track_agreement(bp_line, pyin_events)
    adopt_pyin = agreement >= LEAD_GATE_MIN_AGREEMENT or (not bp_line and bool(pyin_events))
    winner = pyin_events if adopt_pyin else bp_events
    loser = bp_events if adopt_pyin else pyin_events
    return adopt_pyin, agreement, winner, loser


def run_transcription_job(
    *,
    job_id: str,
    params: TranscriptionParams,
    emit: EventEmitter,
    cancel: threading.Event,
    backend: NoteBackend | None = None,
    loader: AudioLoader | None = None,
) -> None:
    """Run the staged transcription job, emitting job.event phases.

    ``backend`` defaults to Basic Pitch; tests inject a deterministic
    fake so the pipeline is exercised without the model stack. ``loader``
    defaults to librosa decode; tests inject synthetic samples so the
    whole stage order runs without the audio stack too.
    """
    started = time.monotonic()

    def stage(index: int) -> None:
        # #385: a stage boundary is position, not fraction — no
        # fabricated percentage rides along (GUI_UX_SPEC honesty).
        emit("progress", stage=STAGES[index])

    def step(index: int, done: int, total: int) -> None:
        # #385: the only in-stage progress allowed — counted work
        # units the stage actually finished (decoded chunks, cleaned
        # voices, quantized voices, verified parts).
        emit(
            "progress",
            stage=STAGES[index],
            step=done,
            totalSteps=total,
        )

    def cancelled(stage_index: int) -> bool:
        if cancel.is_set():
            emit(
                "cancelled",
                stage=STAGES[stage_index],
                reason="cancel requested between stages",
            )
            return True
        return False

    def timed_out(stage_index: int) -> bool:
        if (
            params.deadline_ms is not None
            and (time.monotonic() - started) * 1000.0 > params.deadline_ms
        ):
            emit(
                "failed",
                stage=STAGES[stage_index],
                error={
                    "code": ERR_JOB_TIMEOUT,
                    "message": f"job exceeded deadlineMs={params.deadline_ms}",
                },
            )
            return True
        return False

    def stop(stage_index: int) -> bool:
        return cancelled(stage_index) or timed_out(stage_index)

    # #229: a first-run demucs weight download can sit inside the
    # separation call for minutes with no stage progress -- name the
    # silence once per job, right before the call that triggers it.
    # demucs_available() keeps the note honest: no demucs install
    # means no download is coming.
    _model_download_noted = False

    def emit_model_download_note() -> None:
        nonlocal _model_download_noted
        if _model_download_noted:
            return
        if not (demucs_available() and demucs_weights_pending()):
            return
        _model_download_noted = True
        emit("progress", note="model_download")

    emit("started", stage=STAGES[0])
    try:
        # ---- preparing_audio ------------------------------------------
        if not os.path.isfile(params.audio_path):
            emit(
                "failed",
                stage=STAGES[0],
                error={
                    "code": ERR_JOB_FAILED,
                    "message": f"audio file not found: {params.audio_path}",
                },
            )
            return
        audio_hash = _sha256_file(params.audio_path)
        step(0, 1, 2)
        samples, sample_rate = (loader or load_mono_audio)(params.audio_path)
        step(0, 2, 2)
        duration_sec = len(samples) / float(sample_rate)

        # #229: a selection job slices the decoded audio BEFORE inference
        # — the backend, the beat track, and tempo estimation all see
        # only the chosen span instead of the whole file. Events come
        # back slice-relative; selection_offset_sec maps them to absolute
        # source seconds so clip_to_range, review seek targets, and
        # provenance stay on the original timeline.
        selection_offset_sec = 0.0
        if params.range_kind == "selection":
            sel_lo = params.selection_start_sec or 0.0
            sel_hi = (
                params.selection_end_sec if params.selection_end_sec is not None else duration_sec
            )
            sel_lo = max(0.0, min(sel_lo, duration_sec))
            sel_hi = max(sel_lo, min(sel_hi, duration_sec))
            if sel_hi - sel_lo <= 0.0:
                emit(
                    "failed",
                    stage=STAGES[1],
                    error={
                        "code": ERR_NO_PITCHED_CONTENT,
                        "message": "selection is empty or outside the audio",
                    },
                )
                return
            i0 = int(sel_lo * sample_rate)
            i1 = min(len(samples), math.ceil(sel_hi * sample_rate))
            samples = samples[i0:i1]
            selection_offset_sec = sel_lo

        # #321: whole-piece issues describe the span the engine actually
        # analysed — the selected slice for a selection job, the full
        # file otherwise. duration_sec stays the SOURCE length (meta),
        # it must not double as the analysis scope.
        analysis_range = TimeRange(
            start_sec=selection_offset_sec,
            end_sec=selection_offset_sec + len(samples) / float(sample_rate),
        )

        if stop(0):
            return

        # ---- transcribing (blocking ONNX call) ------------------------
        stage(1)
        # #229: the backend reads a file path — stage the slice as a
        # temp WAV so inference only processes the selected span. A
        # staging failure falls back to the original file (correct, just
        # slower); the temp is always removed after the blocking call.
        # #187: opt-in vocal isolation replaces the staged input with a
        # center-extracted vocal estimate (cache-managed when possible).
        staged_path: str | None = None
        vocal_path: str | None = None
        vocal_managed = False
        vocal_reason: str | None = None
        vocal_method: str | None = None
        vocal_method_version: str | None = None
        # #203: the accompaniment stem travels with the vocal stem —
        # produced by the same separation pass, so it exists whenever
        # vocal_path does (and survives being ignored when the option
        # or texture says no).
        accomp_path: str | None = None
        accomp_managed = False
        # Octave-repair arbitration must read the audio the events
        # were detected on — a stem line judged on the full mix lets
        # accompaniment energy veto real octave snaps and fabricates
        # support for bleed pitches the vocal never carried (the bass
        # is in the mix, not in the stem).  Decoded once here — the
        # temp stem may be unlinked before the clean stage reads it.
        stem_evidence: tuple[Any, int] | None = None
        # #256: the buffer every audio-evidence consumer reads for the
        # LEAD line — the stem when isolation (opt-in or rescue)
        # produced it, the source slice otherwise.  Boundary flags,
        # seam envelopes, octave verdicts and meter event-accents all
        # describe the detected line; on a separated run the mix
        # carries accompaniment transients the line never had.
        lead_evidence: tuple[Any, int] | None = None
        # #203/#204: the isolation span is needed by BOTH the opt-in
        # call below and the auto-rescue in the cleaning stage —
        # hoisted out of the elif so the rescue sees the same bounds.
        vis_lo = params.selection_start_sec or 0.0 if params.range_kind == "selection" else 0.0
        vis_hi = params.selection_end_sec if params.range_kind == "selection" else None
        # #322: vocal isolation is a solo-melody preprocess — under
        # voices/chords the user asked to KEEP the overlapping lines,
        # so stripping the accompaniment first would silently defeat
        # the texture. Skip it and report the conflict instead.
        polyphonic_texture = params.texture in ("voices", "chords")
        # #385: counted sub-steps — vocal isolation (when it will
        # run), selection staging (when needed), the backend call.
        # Each blocks internally; the honest count moves between them.
        transcribe_done = 0
        transcribe_total = (
            1
            + int(params.vocal_isolation and not polyphonic_texture)
            + int(params.range_kind == "selection")
        )
        if params.vocal_isolation and polyphonic_texture:
            vocal_reason = "polyphonic_texture"
        elif params.vocal_isolation:
            # Isolation covers exactly the backend's span: the
            # selection when one is set, else the whole file. A stray
            # selection_start_sec under range=all must not leak in.
            emit_model_download_note()
            (
                vocal_path,
                vocal_reason,
                vocal_managed,
                vocal_method,
                vocal_method_version,
            ) = vocal_wav(
                params.audio_path,
                audio_hash,
                vis_lo,
                vis_hi,
                sample_rate,
                quality=params.vocal_isolation_quality,
            )
            # #203: the companion stem shares the vocal file's
            # lifecycle — managed flag included.
            accomp_path = accompaniment_wav_for(vocal_path)
            accomp_managed = vocal_managed
            if vocal_path is not None:
                # Isolation produced the backend input — the staging
                # unit below is no longer part of the plan.
                transcribe_total -= int(params.range_kind == "selection")
                try:
                    stem_evidence = load_mono_audio(vocal_path)
                except Exception:
                    stem_evidence = None
                lead_evidence = stem_evidence
            transcribe_done += 1
            step(1, transcribe_done, transcribe_total)
        if vocal_path is None and params.range_kind == "selection":
            staged_path = _stage_selection_wav(samples, sample_rate)
            transcribe_done += 1
            step(1, transcribe_done, transcribe_total)
        backend_path = vocal_path or staged_path or params.audio_path
        # #189: "auto" picks the engine that fits the declared
        # texture — a declared-mono source gets the monophonic
        # tracker; mixes keep the polyphonic model.
        # #316/#165: an isolated vocal is USUALLY monophonic — but a
        # bleed-heavy estimate still carries the accompaniment, and
        # the monophonic tracker then locks the loudest surviving
        # line (very-quiet-lead: pYIN followed the bass end-to-end and
        # never heard the lead).  Under "auto" the isolated input
        # therefore goes through the lead-track gate: BOTH engines
        # run, and pYIN's track is adopted only when it agrees with
        # the melody line Basic Pitch arbitrates out of the
        # polyphony.  voices/chords keep the polyphonic model (the
        # user asked for every line); an explicit backend pin still
        # wins over everything; a declared-mono source without
        # isolation keeps the direct pYIN resolution.
        dual_track = (
            backend is None
            and params.backend == "auto"
            and vocal_path is not None
            and params.texture not in ("voices", "chords")
        )
        resolved_pyin = params.backend == "pyin" or (
            params.backend == "auto"
            and (
                params.texture == "mono"
                or (
                    vocal_path is not None
                    and params.texture not in ("voices", "chords")
                    # An injected backend keeps the legacy
                    # resolution — tests drive one deterministic
                    # engine and the gate must not see it.
                    and backend is not None
                )
            )
        )
        # Resolved backend identity for provenance — used by the
        # ScoreDocument fields, the job meta, AND the transcription
        # revision id (#237: the tr-* id must name the backend that
        # actually ran so a backend upgrade mints a new identity).
        backend_id = PYIN_BACKEND_ID if resolved_pyin else BACKEND_ID
        backend_version = BACKEND_VERSION
        if resolved_pyin:
            try:
                import librosa  # noqa: PLC0415

                # #421: the pyin path decodes with the lead-voice Viterbi
                # segmenter — name it in the version so tr-* identities
                # change when the decoder does.
                backend_version = librosa.__version__ + "+lead"
            except Exception:
                backend_version = "unknown"
        elif vocal_path is not None and backend is None:
            # #165: the isolated estimate also gets the two-pass
            # sensitive recall below — name the detection chain in
            # the identity like any other engine version (#319).
            backend_version = BACKEND_VERSION + "+rescue"
        # #319: the revision must name the preprocess that actually
        # ran — the same settings on two installs can feed different
        # audio to the backend (demucs vs center vs raw fallback),
        # so the tr-* identity follows the effective chain, not the
        # request. Recorded on the result meta for provenance too.
        preprocess: dict[str, Any] | None = None
        # #80: the lead-gate's losing track — an independent pitch
        # opinion on the same stem buffer, kept for the octave audit's
        # disagreement arbitration (empty when no gate ran).
        arbiter_events: tuple[RawNoteEvent, ...] = ()
        arbiter_backend = ""
        if params.vocal_isolation:
            preprocess = {
                "vocalIsolation": True,
                "method": vocal_method or "none",
                "methodVersion": vocal_method_version,
                # Why isolation did not apply (mono_source /
                # unavailable) — absent on a successful run.
                **({"fallbackReason": vocal_reason} if vocal_path is None and vocal_reason else {}),
            }
        revision = new_transcription_revision(
            audio_hash or params.audio_path,
            params.settings_dict(),
            backend_id=backend_id,
            backend_version=backend_version,
            preprocess=preprocess,
        )
        # Melody/auto/polyphonic textures widen the detection band:
        # JPOP vocals and mix melodies sit above the 880 Hz horn cap
        # (#236: auto must detect before it can judge — an 880 Hz
        # ceiling would drop the melody before the auto classifier
        # ever sees it).  Only the explicitly-monophonic texture
        # keeps the narrow horn band.
        max_hz = MELODY_MAX_FREQUENCY_HZ if params.texture != "mono" else None
        hz_kwargs: dict[str, Any] = {"max_frequency_hz": max_hz} if max_hz else {}
        try:
            if backend is not None:
                raw_events = backend(backend_path)
            elif dual_track:
                # The gate runs both engines under their own
                # provenance — the discarded track's revision is
                # thrown away with it, the winner's becomes THE
                # transcription revision (#237).
                pyin_version = "unknown"
                try:
                    import librosa  # noqa: PLC0415

                    pyin_version = librosa.__version__ + "+lead"
                except Exception:
                    pass
                pyin_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=PYIN_BACKEND_ID,
                    backend_version=pyin_version,
                    preprocess=preprocess,
                )
                adopt_pyin, agreement, gate_events, gate_loser = _lead_track_gate(
                    backend_path,
                    bp_revision=revision,
                    pyin_revision=pyin_revision,
                    hz_kwargs=hz_kwargs,
                    prefer="top" if params.texture == "melody" else "onset",
                )
                raw_events = gate_events
                arbiter_events = gate_loser
                arbiter_backend = BACKEND_ID if adopt_pyin else PYIN_BACKEND_ID
                if adopt_pyin:
                    resolved_pyin = True
                    revision = pyin_revision
                    backend_id = PYIN_BACKEND_ID
                    backend_version = pyin_version
                if preprocess is not None:
                    # Gate bookkeeping rides the meta's preprocess
                    # echo — the identity itself already names the
                    # adopted chain, so it stays out of the hash.
                    preprocess["leadTrackGate"] = {
                        "pyinAgreement": round(agreement, 4),
                        "adopted": "pyin" if adopt_pyin else "basicPitch",
                    }
            elif resolved_pyin:
                # #175: monophonic tracker — better for a single
                # sung line.
                raw_events = predict_note_events_pyin(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
            elif vocal_path is not None:
                # #165: two-pass sensitive recall on the isolated
                # estimate — a buried lead can sit under production
                # thresholds where the model still tracks it faintly.
                raw_events = predict_note_events_rescued(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
            else:
                raw_events = predict_note_events(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
        finally:
            if staged_path is not None:
                with contextlib.suppress(OSError):
                    os.unlink(staged_path)
            if vocal_path is not None and not vocal_managed:
                with contextlib.suppress(OSError):
                    os.unlink(vocal_path)
        if staged_path is not None or vocal_path is not None:
            raw_events = _shift_event_times(raw_events, selection_offset_sec)
            # The arbiter rides the same timeline — it came off the
            #  same staged buffer, so the selection shift applies too.
            if arbiter_events:
                arbiter_events = _shift_event_times(
                    arbiter_events, selection_offset_sec
                )
        step(1, transcribe_done + 1, transcribe_total)
        if stop(1):
            return

        # ---- cleaning --------------------------------------------------
        stage(2)
        ranged = clip_to_range(raw_events, params.selection_start_sec, params.selection_end_sec)
        prefer = "top" if params.texture == "melody" else "onset"
        # #180: pyin already bridges tracker dropouts and splits real
        # re-articulations at onset times — re-merging same-pitch
        # neighbours inside clean_monophonic would undo that split.
        clean_merge_gap = 0.0 if resolved_pyin else MERGE_GAP_SEC

        # Octave-flicker repair evidence: when the neighbour pitch-class
        # rule proposes snapping a note across an octave, the note's own
        # spectrum arbitrates — a played octave figure carries its real
        # fundamental, a tracker flicker does not (octave-leaps-4-4:
        # honest C4->C5->C4 figures were being flattened).  The verdict
        # reads the analysis buffer, so event times map back through
        # selection_offset_sec exactly like the seam envelopes do.
        # Stem-detected events are judged on the STEM buffer (decoded
        # above), never on the full mix — the detected line's evidence
        # is only honest in the audio it was tracked from.
        def _octave_verdict_on(
            buffer: tuple[Any, int],
        ) -> Callable[[RawNoteEvent, float], bool]:
            buf, sr = buffer

            def _verdict(ev: RawNoteEvent, target: float) -> bool:
                return octave_prefers(
                    buf,
                    sr,
                    ev.onset_sec,
                    ev.offset_sec,
                    ev.pitch_midi,
                    target,
                    time_offset_sec=selection_offset_sec,
                )

            return _verdict

        _octave_ev = _octave_verdict_on(
            lead_evidence if lead_evidence is not None else (samples, sample_rate)
        )

        voice_split = None
        if params.texture in ("voices", "chords"):
            # #85: keep detected lines as separate parts — a chord
            # survives as voices instead of dropping the lowest note.
            # #155: the chords texture splits the same way, then merges
            # the voices into one part at build time.  #355: the cap is
            # the job's maxVoices (default 3, up to 8) — four-part
            # harmony is ordinary in chord-oriented sources.
            voice_split = split_voices(ranged, max_voices=params.max_voices)
            clean_total = len(voice_split.voices)
            cleaned = clean_monophonic(
                voice_split.voices[0],
                merge_gap_sec=clean_merge_gap,
                octave_verdict=_octave_ev,
            )
            step(2, 1, clean_total)
            cleaned_lowers = []
            for i, v in enumerate(voice_split.voices[1:]):
                cleaned_lowers.append(
                    clean_monophonic(
                        v,
                        merge_gap_sec=clean_merge_gap,
                        octave_verdict=_octave_ev,
                    )
                )
                step(2, 2 + i, clean_total)
        else:
            # boundary-4-4: same-pitch re-articulations (tongued
            # repeats) were being merged into one note. The boundary
            # expert's seam evidence arbitrates — but only under the
            # mono contract, where any attack on the seam belongs to
            # this line. Under melody/voices textures accompaniment
            # and other-voice onsets pollute the envelope, so their
            # merges stay unconditional (a mix transient is exactly
            # the false attack healing exists for). pyin already
            # splits articulations itself, hence clean_merge_gap > 0.
            edge_ev = None
            if prefer == "onset" and clean_merge_gap > 0:
                # #256: seam evidence describes the line being cleaned
                # — the stem when the events were detected on one;
                # the mix would invent attacks the vocal never had.
                _ev_buf, _ev_sr = (
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                )
                edge_env = compute_envelopes(
                    _ev_buf,
                    _ev_sr,
                    time_offset_sec=selection_offset_sec,
                )

                def _separated(a: RawNoteEvent, b: RawNoteEvent) -> bool:
                    return seam_evidence(a, b, edge_env).separated

                edge_ev = _separated
            cleaned = clean_monophonic(
                ranged,
                merge_gap_sec=clean_merge_gap,
                prefer=prefer,
                edge_evidence=edge_ev,
                octave_verdict=_octave_ev,
            )
            cleaned_lowers = []
            step(2, 1, 1)
        # #148: remember when auto detected a mix — the overlap warning
        # then suggests re-transcribing with the voices texture so the
        # accompaniment is not silently merged into the melody.
        # #204: the mix signature is BOTH the auto re-clean trigger and
        # the rescue gate — read it once off the first clean, before a
        # prefer="top" pass could fold the overlaps it counts.
        mix_signature = (
            bool(cleaned.events)
            and cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
            and cleaned.polyphonic_overlaps / len(cleaned.events) >= AUTO_TEXTURE_OVERLAP_RATIO
        )
        auto_mix_detected = params.texture == "auto" and mix_signature
        # #204: under auto/melody a detected mix now tries vocal
        # isolation BEFORE settling for the top-voice clip — the user
        # asked for the melody of a mix, and the isolated stem keeps
        # far more of it than clip-the-overlaps ever could. Explicit
        # contracts are honoured: an injected test backend, a pinned
        # pyin engine, an explicit vocalIsolation=False under voices/
        # chords (already skipped above), or a declared-mono source
        # all stay on the raw path.
        rescue_applied = False
        if (
            mix_signature
            and params.texture in ("auto", "melody")
            and not params.vocal_isolation
            and params.backend != "pyin"
            and backend is None
            and vocal_path is None
        ):
            emit_model_download_note()
            (
                rescue_vocal_path,
                _rescue_reason,
                rescue_managed,
                rescue_method,
                rescue_method_version,
            ) = vocal_wav(
                params.audio_path,
                audio_hash,
                vis_lo,
                vis_hi,
                sample_rate,
                # Engine-initiated separation keeps the fast tier — a
                # ~4x precision run is the user's explicit choice,
                # not something the pipeline spends silently.
                quality="standard",
            )
            rescue_accomp_path = (
                accompaniment_wav_for(rescue_vocal_path) if rescue_vocal_path is not None else None
            )
            rescue_cleaned = None
            rescue_events: tuple[RawNoteEvent, ...] = ()
            rescue_adopted_pyin = False
            rescue_pyin_revision: TranscriptionRevisionId | None = None
            rescue_pyin_version = ""
            if rescue_vocal_path is not None and not stop(2):
                rescue_preprocess = {
                    "vocalIsolation": True,
                    "method": rescue_method or "none",
                    "methodVersion": rescue_method_version,
                    "auto": True,
                }
                rescue_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=BACKEND_ID,
                    backend_version=BACKEND_VERSION + "+rescue",
                    preprocess=rescue_preprocess,
                )
                # #234: the rescue stem gets the same dual-track
                # arbitration the opt-in path runs (#165) -- on a real
                # mix the ungated Basic Pitch line crushed ~270
                # polyphonic overlaps into the top voice; a pYIN
                # track that agrees with the melody line is the
                # cleaner single-line answer.
                rescue_pyin_version = "unknown"
                try:
                    import librosa  # noqa: PLC0415

                    rescue_pyin_version = librosa.__version__ + "+lead"
                except Exception:
                    pass
                rescue_pyin_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=PYIN_BACKEND_ID,
                    backend_version=rescue_pyin_version,
                    preprocess=rescue_preprocess,
                )
                try:
                    rescue_adopted_pyin, agreement, gate_events, _ = _lead_track_gate(
                        rescue_vocal_path,
                        bp_revision=rescue_revision,
                        pyin_revision=rescue_pyin_revision,
                        hz_kwargs=hz_kwargs,
                        prefer="top",
                    )
                    rescue_events = gate_events
                    rescue_preprocess["leadTrackGate"] = {
                        "pyinAgreement": round(agreement, 4),
                        "adopted": "pyin" if rescue_adopted_pyin else "basicPitch",
                    }
                except Exception:
                    try:
                        rescue_events = predict_note_events_rescued(
                            rescue_vocal_path,
                            revision=rescue_revision,
                            **hz_kwargs,
                        )
                    except Exception:
                        rescue_events = ()
                rescue_events = _shift_event_times(rescue_events, selection_offset_sec)
                rescue_ranged = clip_to_range(
                    rescue_events,
                    params.selection_start_sec,
                    params.selection_end_sec,
                )
                # Same evidence rule as the opt-in stem: the rescue
                # stem's own buffer arbitrates its octave repairs —
                # the mix would veto true snaps with accompaniment
                # energy that is not in the detected line.
                rescue_evidence: tuple[Any, int] | None = None
                try:
                    rescue_evidence = load_mono_audio(rescue_vocal_path)
                except Exception:
                    rescue_evidence = None
                rescue_cleaned = clean_monophonic(
                    rescue_ranged,
                    # #180: an adopted pYIN track already bridges
                    # dropouts — re-merging would undo its real
                    # re-articulation splits.
                    merge_gap_sec=0.0 if rescue_adopted_pyin else MERGE_GAP_SEC,
                    prefer="top",
                    octave_verdict=_octave_verdict_on(
                        rescue_evidence
                        if rescue_evidence is not None
                        else (samples, sample_rate)
                    ),
                )
            if rescue_cleaned is not None and rescue_cleaned.events:
                # Adopt the rescue: provenance re-mints so the tr-* id
                # names the chain that actually produced the score.
                if rescue_adopted_pyin and rescue_pyin_revision is not None:
                    # #234: the gate picked pYIN — the adopted track's
                    # own identity becomes THE revision (#237), same
                    # rule the opt-in dual_track path follows.
                    revision = rescue_pyin_revision
                    backend_id = PYIN_BACKEND_ID
                    backend_version = rescue_pyin_version
                    resolved_pyin = True
                else:
                    revision = rescue_revision
                    backend_id = BACKEND_ID
                    backend_version = BACKEND_VERSION + "+rescue"
                preprocess = rescue_preprocess
                vocal_path = rescue_vocal_path
                vocal_managed = rescue_managed
                vocal_reason = "applied"
                vocal_method = rescue_method
                vocal_method_version = rescue_method_version
                accomp_path = rescue_accomp_path
                accomp_managed = rescue_managed
                ranged = rescue_ranged
                cleaned = rescue_cleaned
                rescue_applied = True
                # #256: every downstream audio-evidence read for the
                # lead now resolves against the rescue stem — the
                # events were detected on it, not on the mix.
                lead_evidence = rescue_evidence
                auto_mix_detected = params.texture == "auto"
                # Adopting the stem replaces the whole raw-event set —
                # earlier raw detection output is discarded.
                raw_events = rescue_events
                # Same temp lifecycle as the opt-in path — the
                # backend already consumed the stem.
                if not vocal_managed:
                    with contextlib.suppress(OSError):
                        os.unlink(vocal_path)
            else:
                # Stem empty or detection failed — drop the rescue
                # temps; the top-voice fallback below still applies.
                for p, managed in (
                    (rescue_vocal_path, rescue_managed),
                    (rescue_accomp_path, rescue_managed),
                ):
                    if p and not managed:
                        with contextlib.suppress(OSError):
                            os.unlink(p)
            if rescue_applied:
                step(2, 2, 2)
        if auto_mix_detected and not rescue_applied:
            # Mix detected — keep the melody line instead of clipping
            # it (the #204 rescue did not produce a usable stem).
            cleaned = clean_monophonic(
                ranged,
                merge_gap_sec=clean_merge_gap,
                prefer="top",
                octave_verdict=_octave_ev,
            )
            # The re-clean is a second real unit — the total grows
            # from 1 to 2 only when the mix signature actually
            # forced the extra pass.
            step(2, 2, 2)
        # #200: a mono-declared job with the same overlap signature
        # probably means the audio was not actually monophonic — the
        # voices re-run remedy applies there too (melody intentionally
        # folds accompaniment into the top line, so it stays exempt).
        mix_suggest_voices = auto_mix_detected or (
            params.texture == "mono"
            and cleaned.events
            and cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
            and cleaned.polyphonic_overlaps / len(cleaned.events) >= AUTO_TEXTURE_OVERLAP_RATIO
        )
        if not cleaned.events:
            emit(
                "failed",
                stage=STAGES[2],
                error={
                    "code": ERR_NO_PITCHED_CONTENT,
                    "message": "no pitched notes detected in the audio",
                },
            )
            return
        # #203/#213: accompaniment staff — when isolation (opt-in or
        # the #204 rescue) produced an accompaniment stem and the job
        # did not opt out, detect its lines on the same grid.  Up to
        # four voices are kept so triads and seventh chords survive;
        # they merge into ONE accompaniment staff at build time, where
        # aligned rhythms render as in-part chords.
        accomp_cleaned: list[CleanedEvents] = []
        # #244: running count of sub-floor flicker dropped from the
        # accompaniment detections, reported in meta for review.
        accomp_conf_dropped = 0
        # #233/#260/#259: grab the stem's decoded audio + evidence
        # curves now, while the file still exists -- stage 3 uses the
        # onset/flux pools for meter accents, stage 5 reuses the
        # samples for the chord map.
        accomp_y, accomp_env_sr, accomp_env = _stem_analysis(accomp_path)
        if accomp_path is not None and params.accompaniment_part:
            # The accomp voices were detected on the accompaniment
            # stem — their octave-flicker arbitration must read THAT
            # stem.  _octave_ev is bound to the vocal stem (or the
            # source for unseparated jobs): judging accomp events on
            # the vocal stem vetoes every snap, since the stem's
            # whole point is that the accompaniment is not in it.
            accomp_evidence: tuple[Any, int] | None = (
                (accomp_y, accomp_env_sr) if accomp_y is not None else None
            )
            _accomp_octave_ev = _octave_verdict_on(
                accomp_evidence
                if accomp_evidence is not None
                else (samples, sample_rate)
            )
            try:
                accomp_events = predict_note_events(
                    accomp_path,
                    revision=revision,
                    # The accompaniment band is the full melody band —
                    # a declared-mono texture caps the LEAD at 880 Hz
                    # but backing keys/guitar live far above it.
                    max_frequency_hz=MELODY_MAX_FREQUENCY_HZ,
                )
            except Exception:
                accomp_events = ()
            # A second predict_* call re-mints rne-* ids from zero —
            # identical to the lead line's ids.  Rename BEFORE the
            # events enter the shared event_by_id namespace or an
            # accompaniment note would resolve its pitch/confidence
            # off the colliding lead event and render garbage.
            accomp_events = tuple(
                replace(e, id=RawNoteEventId(f"rne-a{i + 1:06d}"))
                for i, e in enumerate(accomp_events)
            )
            accomp_events = _shift_event_times(accomp_events, selection_offset_sec)
            accomp_ranged = clip_to_range(
                accomp_events,
                params.selection_start_sec,
                params.selection_end_sec,
            )
            # #244: the "other" stem is Basic-Pitch flicker-heavy --
            # drop short sub-confidence detections before they vote
            # for voices or gate lead notes as bleed.
            pre_floor = len(accomp_ranged)
            accomp_ranged = _accomp_confidence_floor(accomp_ranged)
            accomp_conf_dropped += pre_floor - len(accomp_ranged)
            if accomp_ranged:
                a_split = split_voices(
                    accomp_ranged,
                    max_voices=min(4, params.max_voices),
                )
                for v in a_split.voices:
                    c = clean_monophonic(
                        v,
                        merge_gap_sec=MERGE_GAP_SEC,
                        octave_verdict=_accomp_octave_ev,
                    )
                    if c.events:
                        accomp_cleaned.append(c)
            # The stem file's job ends at detection — an unmanaged
            # temp is released here, the managed cache copy stays.
            if not accomp_managed:
                with contextlib.suppress(OSError):
                    os.unlink(accomp_path)
            accomp_path = None
        elif accomp_path is not None and not accomp_managed:
            # Part opted out — release the unused stem temp.
            with contextlib.suppress(OSError):
                os.unlink(accomp_path)
            accomp_path = None
        # #236: the lead track keeps only notes the accompaniment stem
        # does NOT explain -- sub-register bleed lands in the 伴奏 part
        # where it belongs instead of dragging the melody into bass
        # clef. Runs before rhythm analysis so fake bass onsets never
        # reach the accent pool either.
        if accomp_cleaned and cleaned.events:
            cleaned = _drop_stem_bleed_lows(cleaned, accomp_cleaned)
        if stop(2):
            return

        # ---- analyzing_rhythm -----------------------------------------
        stage(3)
        meter = params.meter_segment()
        meter_estimated = False
        meter_uncertain = False
        meter_est_label: str | None = None
        meter_runner_up: str | None = None
        pulse_unit_ql: Fraction | None = None
        # #385: counted sub-steps — beat track (when needed), meter
        # estimate (auto only), tempo estimate.
        rhythm_done = 0
        rhythm_total = 0
        # #229: the beat track runs on the slice, so it must also run
        # whenever estimate_tempo would track internally on the slice —
        # a pinned meter + auto tempo + selection would otherwise mix
        # slice-relative beat anchors with absolute event times and
        # misplace the whole warp. Shifted beats are absolute seconds,
        # matching the events.
        need_beats = params.meter == "auto" or (
            params.tempo_bpm is None and selection_offset_sec > 0.0
        )
        rhythm_total += int(need_beats) + int(params.meter == "auto") + 1
        if need_beats:
            tracked_times, strengths = _track_beats(samples, sample_rate)
            beat_times = tuple(t + selection_offset_sec for t in tracked_times)
            rhythm_done += 1
            step(3, rhythm_done, rhythm_total)
        else:
            beat_times = None
            strengths = ()
        if params.meter == "auto":
            # #228: auto meter reads accents off a beat track — run it
            # even when the user pinned the tempo (the pinned BPM only
            # replaces the warp; the accent evidence is still real).
            # The same track feeds the tempo warp when tempo is auto.
            accents = _event_accents(
                (e for c in (cleaned, *cleaned_lowers) for e in c.events),
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                time_offset_sec=selection_offset_sec,
            )
            # #233: on a separated mix the melody line's onsets are the
            # WORST meter evidence (vocal phrases start off-beat); the
            # no_vocals stem still carries the drums/bass that mark
            # downbeats -- inject its percussive envelope, sampled at
            # the tracked beats and normalised into the accent-RMS
            # scale so the pool stays internally consistent.
            if accomp_env is not None and beat_times:
                stem_acc = [
                    (
                        t,
                        float(accomp_env[i])
                        if 0
                        <= (i := int(round((t - vis_lo) * accomp_env_sr / 512.0)))
                        < len(accomp_env)
                        else 0.0,
                    )
                    for t in beat_times
                ]
                chan_vals = sorted(a for _, a in stem_acc if a > 0)
                base_vals = sorted(a for _, a in accents if a > 0)
                # Normalise onto the accent pool's p90 (peak range, not
                # the noise-floor median): the stem env is then in the
                # same unit the slot-max comparison runs on. With no
                # vocal accents at all the raw env still works — the
                # meter read is scale-free within one pool.
                base_ref = (
                    base_vals[min(len(base_vals) - 1, int(len(base_vals) * 0.9))]
                    if base_vals
                    else 0.0
                )
                chan_ref = (
                    chan_vals[min(len(chan_vals) - 1, int(len(chan_vals) * 0.9))]
                    if chan_vals
                    else 0.0
                )
                scale = (
                    base_ref / chan_ref
                    if base_ref > 0 and chan_ref > 0
                    else (1.0 if chan_ref > 0 else 0.0)
                )
                if scale > 0:
                    accents = tuple(
                        sorted(
                            (*accents, *((t, a * scale) for t, a in stem_acc)),
                            key=lambda p: p[0],
                        )
                    )
            meter_est = estimate_meter(beat_times or (), strengths, event_accents=accents)
            meter_est_label = meter_est.meter
            # #24 contract fix: an uncertain estimate never writes its
            # guess — the estimator contract (meter.py) says the caller
            # falls back to 4/4 and lets the meter_conflict review
            # issue carry the rejected label, so the user overrides a
            # readable score instead of living under a coin flip.
            label = "4/4" if meter_est.uncertain else meter_est.meter
            meter = MeterSegment(
                start_ql=Fraction(0),
                numerator=int(label.split("/")[0]),
                denominator=int(label.split("/")[1]),
            )
            meter_estimated = True
            meter_uncertain = meter_est.uncertain
            meter_confidence = meter_est.confidence
            meter_runner_up = meter_est.runner_up
            # A non-beat tracked pulse anchors only when the meter read
            # was trusted — an uncertain guess must not re-denominate
            # the tracked beat (that is exactly how a misread 6/8
            # printed "37.45" for a ~108 bpm source).
            if meter_est.tracked_unit_ql is not None and not meter_est.uncertain:
                pulse_unit_ql = meter_est.tracked_unit_ql
            rhythm_done += 1
            step(3, rhythm_done, rhythm_total)
        else:
            meter_confidence = 1.0
        estimate = estimate_tempo(
            samples,
            sample_rate,
            meter,
            tempo_bpm=params.tempo_bpm,
            first_onset_sec=cleaned.events[0].onset_sec,
            beat_times=beat_times,
            pulse_unit_ql=pulse_unit_ql,
            beat_strengths=strengths,
        )
        rhythm_done += 1
        step(3, rhythm_done, rhythm_total)
        if estimate.pickup_len_ql:
            meter = MeterSegment(
                start_ql=Fraction(0),
                numerator=meter.numerator,
                denominator=meter.denominator,
                measure_phase_ql=(meter.measure_length_ql - estimate.pickup_len_ql),
            )
        meter_map = MeterMap((meter,))
        if stop(3):
            return

        # ---- quantizing ------------------------------------------------
        stage(4)
        profile = params.quantization_profile()
        alternatives = quantize_events(cleaned.events, estimate.warp, meter_map, profile)
        # #385: one real unit per quantized voice.
        quantize_total = 1 + sum(1 for c in cleaned_lowers if c.events)
        # #203: each surviving accompaniment voice is a real unit too.
        quantize_total += len(accomp_cleaned)
        step(4, 1, quantize_total)
        if not alternatives:
            emit(
                "failed",
                stage=STAGES[4],
                error={
                    "code": ERR_NO_PITCHED_CONTENT,
                    "message": "quantization produced no notes",
                },
            )
            return
        best = alternatives[0]
        # #85 (voices texture): the second voice quantizes against the
        # SAME tempo/meter map AND the same alignment shift — separate
        # searches would let the parts drift against each other.
        lower_alternatives = []
        quantize_done = 1
        for cleaned_lower in cleaned_lowers:
            if not cleaned_lower.events:
                continue
            alts = quantize_events(
                cleaned_lower.events,
                estimate.warp,
                meter_map,
                profile,
                alignment_shift_sec=best.diagnostics.alignment_shift_sec,
            )
            if alts:
                lower_alternatives.append(alts)
            quantize_done += 1
            step(4, quantize_done, quantize_total)
        if stop(4):
            return
        # #203: accompaniment voices quantize against the SAME warp,
        # meter map and alignment shift — the two staves must stay
        # glued to one grid.
        accomp_alternatives = []
        # #213: the voices merge into ONE accompaniment part at build
        # time, so their events merge into ONE evidence list too —
        # raw_evidence.parts must line up 1:1 with payload.parts or
        # requantize silently falls back to the synthetic path.
        accomp_evidence: list[RawNoteEvent] = []
        for c in accomp_cleaned:
            alts = quantize_events(
                c.events,
                estimate.warp,
                meter_map,
                profile,
                alignment_shift_sec=best.diagnostics.alignment_shift_sec,
            )
            if alts:
                accomp_alternatives.append(alts)
                accomp_evidence.extend(c.events)
            quantize_done += 1
            step(4, quantize_done, quantize_total)
        if stop(4):
            return

        # ---- building_score -------------------------------------------
        stage(5)
        # #385: counted sub-steps — key analysis, swing census, tempo
        # octave census (auto tempo only), build_score, evidence doc.
        build_done = 0
        build_total = 4 + int(estimate.auto)
        event_by_id: dict[RawNoteEventId, RawNoteEvent] = {e.id: e for e in cleaned.events}
        for cleaned_lower in cleaned_lowers:
            for e in cleaned_lower.events:
                event_by_id.setdefault(e.id, e)
        for c in accomp_cleaned:
            for e in c.events:
                event_by_id.setdefault(e.id, e)
        key_pitches: list[int] = []
        key_durations: list[Fraction] = []
        key_onsets: list[Fraction] = []
        beat_ql = Fraction(4, meter.denominator)
        for n in best.notes:
            src = [event_by_id[e] for e in n.source_event_ids if e in event_by_id]
            if not src:
                continue
            key_pitches.append(int(round(src[0].pitch_midi)))
            key_durations.append(n.duration_ql)
            key_onsets.append(n.onset_ql / beat_ql)
        # #133: measure boundaries on the canonical BEAT axis — the
        # pickup measure spans [0, pickup), then full measures tile from
        # there. Key segments snap to these starts.
        measure_len_ql = meter.measure_length_ql
        measure_starts: list[Fraction] = [Fraction(0)]
        pos = (estimate.pickup_len_ql or measure_len_ql) / beat_ql
        last_onset = max((n.onset_ql / beat_ql for n in best.notes), default=Fraction(0))
        while pos <= last_onset:
            measure_starts.append(pos)
            pos += measure_len_ql / beat_ql
        # #352: one analysis produces the key map AND the uncertainty
        # evidence — segmentation guards live inside analyze_key.
        # #53: a user-pinned key replaces the analysis entirely —
        # spelling, chord priors and the signature all take the hint,
        # and no key_uncertain issue can fire on a user attestation.
        key_hint_sig = params.key_signature_hint()
        key_analysis = None
        if key_hint_sig is not None:
            key = key_hint_sig
            key_changes: tuple[KeyChange, ...] = ()
            key_confidence = 1.0
        else:
            key_analysis = analyze_key(
                tuple(key_pitches),
                tuple(key_onsets),
                tuple(key_durations),
                tuple(measure_starts),
            )
            key = key_analysis.key
            key_changes = key_analysis.changes
            key_confidence = key_analysis.confidence
        # #419: chord map — half-measure segments snapped to the
        # canonical beat grid, chroma-matched then Viterbi-smoothed
        # under the key prior. Runs on the slice; a failure leaves an
        # empty map rather than sinking the job (enhancement layer).
        prefer_flats = key.fifths < 0
        chord_map: tuple[ChordEstimate, ...] = ()
        chord_symbols: tuple[ChordSymbol, ...] = ()
        try:
            half_beats = measure_len_ql / (2 * beat_ql)
            bounds: set[Fraction] = {Fraction(0)}
            for ms in measure_starts:
                bounds.add(ms + half_beats)
                bounds.add(ms + measure_len_ql / beat_ql)
            ordered_bounds = sorted(bounds)
            # Segment defs keep the canonical BEAT bounds next to the
            # audio seconds - estimate_chords consumes the seconds,
            # and the beat bounds tag the returned estimates one-to-
            # one as ScoreDocument chord symbols (#44).
            seg_beats: list[tuple[Fraction, Fraction]] = []
            seg_secs: list[tuple[float, float]] = []
            for lo_b, hi_b in pairwise(ordered_bounds):
                lo_s = estimate.warp.ql_to_seconds(lo_b * beat_ql) - selection_offset_sec
                hi_s = estimate.warp.ql_to_seconds(hi_b * beat_ql) - selection_offset_sec
                if hi_s > lo_s:
                    seg_beats.append((lo_b, hi_b))
                    seg_secs.append((lo_s, hi_s))
            chord_map = tuple(
                replace(
                    est,
                    start_sec=est.start_sec + selection_offset_sec,
                    end_sec=est.end_sec + selection_offset_sec,
                )
                for est in estimate_chords(
                    # #259: the accompaniment stem carries the harmony
                    # without vocal non-chord tones or the drum mask —
                    # chroma read off it resolves the maj7/min7 pairs
                    # the full mix kept collapsing. Falls back to the
                    # mix when no separation ran.
                    accomp_y if accomp_y is not None else samples,
                    accomp_env_sr if accomp_y is not None else sample_rate,
                    tuple(seg_secs),
                    diatonic=diatonic_chords(key.fifths, key.mode),
                    prefer_flats=prefer_flats,
                )
            )
            chord_symbols = tuple(
                ChordSymbol(
                    start_beat=lo_b,
                    end_beat=hi_b,
                    root_pc=est.root_pc,
                    quality=est.quality,
                    confidence=est.confidence,
                    margin=est.margin,
                    label=est.label(prefer_flats),
                )
                for (lo_b, hi_b), est in zip(seg_beats, chord_map, strict=True)
            )
        except Exception:  # noqa: BLE001 - enhancement layer
            chord_map = ()
            chord_symbols = ()
        build_done += 1
        step(5, build_done, build_total)
        tempo_map = tempo_map_from_estimate(estimate, meter)
        shift = best.diagnostics.alignment_shift_sec
        # #134 swing feel: census the normalized offbeat onsets — a
        # dominant 2/3-of-beat cluster with a quiet 1/3 cluster reads
        # as shuffle, not triplets. The estimate lands on the payload
        # (notation emits a swing direction) AND feeds a review issue.
        normalized = normalize_to_score_time(
            cleaned.events, estimate.warp, alignment_shift_sec=shift
        )
        swing_est = detect_swing(
            tuple(n.onset_ql for n in normalized),
            Fraction(4, meter.denominator),
        )
        build_done += 1
        step(5, build_done, build_total)
        # #188 tempo octave census — only meaningful when the tempo
        # came from tracking (a pinned BPM is the user's word).
        tempo_octave = (
            detect_tempo_octave(
                tuple(e.onset_sec for e in cleaned.events),
                estimate.beat_times_sec,
            )
            if estimate.auto
            else None
        )
        if estimate.auto:
            build_done += 1
            step(5, build_done, build_total)
        built = build_score(
            best,
            meter,
            tempo_map,
            key,
            pickup_len_ql=estimate.pickup_len_ql,
            event_by_id=event_by_id,
            # #305: the score title is the user's file name, not the
            # path the backend actually read — a staged browser-dev
            # temp would otherwise leak ``staged-<ts>-`` onto the page.
            title=(
                Path(params.display_name).stem
                if params.display_name
                else Path(params.audio_path).stem
            ),
            source_audio_path=params.audio_path,
            source_audio_hash=audio_hash,
            settings=params.settings_dict(),
            extra_voices=(tuple(alts[0] for alts in lower_alternatives)),
            extra_parts=(
                # #213: all surviving accompaniment voices merge into
                # ONE staff — same-rhythm notes become in-part chords,
                # the rest become notation layers, and voice-1 gaps
                # get synthesized measure rests so layer 0 still tiles.
                (("伴奏", tuple(alts[0] for alts in accomp_alternatives)),)
                if accomp_alternatives
                else ()
            ),
            merge_voices=params.texture == "chords",
            voice_names=(
                # #251: the chords texture is an analytical capture of
                # simultaneous notes, not a one-player part — the part
                # name says so wherever the score is exported.
                ("Horn in F (chords)",) if params.texture == "chords" else ()
            ),
            key_changes=key_changes,
            swing_feel=(swing_est.mean_phase if swing_est.detected else None),
            transcription_backend=backend_id,
            transcription_backend_version=backend_version,
        )
        build_done += 1
        step(5, build_done, build_total)
        # #223/#226: persist the raw transcription evidence inline on
        # the document — the cleaned events per part plus the warp that
        # mapped them. A later requantize replays the real performance
        # under new settings instead of re-rounding the notation, and
        # the evidence survives project saves/restarts (the document is
        # already stored inside the project file).
        evidence_parts = (
            [
                sorted(
                    [e for c in (cleaned, *cleaned_lowers) for e in c.events],
                    key=lambda e: (e.onset_sec, e.pitch_midi, str(e.id)),
                )
            ]
            if params.texture == "chords"
            else [list(c.events) for c in (cleaned, *cleaned_lowers)]
        )
        # #203/#213: the merged accompaniment part keeps its events in
        # evidence too — one entry per emitted part (positional parity
        # with payload.parts is what lets requantize replay them).
        if accomp_evidence:
            evidence_parts.append(
                sorted(
                    accomp_evidence,
                    key=lambda e: (e.onset_sec, e.pitch_midi, str(e.id)),
                )
            )
        document = replace(
            built.document,
            raw_evidence={
                "transcriptionRevision": str(revision),
                "warp": _warp_evidence(estimate.warp),
                "parts": [{"events": [e.to_dict() for e in evs]} for evs in evidence_parts],
            },
            # #44: the chord map rides along as document-level
            # analysis - MusicXML export renders it as <harmony>.
            chord_symbols=chord_symbols,
        )
        build_done += 1
        step(5, build_done, build_total)
        payload = built.payload
        score_revision = payload.revision_id()

        # Review issues: quantizer reasons + confidence/range/length.
        issues = list(
            generate_review_issues(
                alternatives,
                normalized,
                meter_map,
                profile,
                score_revision=score_revision,
                warp=estimate.warp,
                beat_ql=beat_ql,
            )
        )
        quantizer_issues_count = len(issues)
        # #249: per-note checks (confidence / horn range / duration)
        # only make sense on the transposing horn staves -- the
        # accompaniment part is covered by the single
        # ACCOMPANIMENT_PART marker (#212), and flagging its notes
        # floods the review list (a piano bass line reads as hundreds
        # of "outside horn range" cautions that also crowd real lead
        # warnings out of the severity cap).
        issues.extend(
            _extra_issues(
                tuple(
                    n
                    for p in built.payload.parts
                    if p.transposing
                    for n in p.notes
                ),
                built.note_confidence,
                built.note_onset_sec,
                event_by_id,
                score_revision,
            )
        )
        # #272: severity-priority cap — warnings surface before
        # cautions before infos, ties broken by time. A flood of
        # early low-severity detections can no longer silently drop
        # a later warning; the omitted count lands in reviewSummary.
        _severity_rank = {
            Severity.WARNING: 0,
            Severity.CAUTION: 1,
            Severity.INFO: 2,
        }
        extras = issues[quantizer_issues_count:]
        extras.sort(
            key=lambda i: (
                _severity_rank.get(i.severity, 3),
                i.time_range.start_sec,
            )
        )
        omitted_extras = extras[MAX_EXTRA_ISSUES:]
        issues = issues[: len(issues) - len(extras)] + extras[:MAX_EXTRA_ISSUES]
        # #360: the cap trims what the review UI SURFACES, not what the
        #  result knows — omitted extras ride along so the desktop can
        #  expand the full list on demand (and the project save keeps
        #  them). Detection must never be silently dropped.
        omitted_by_severity: dict[str, int] = {}
        for i in omitted_extras:
            sev = i.severity.value
            omitted_by_severity[sev] = omitted_by_severity.get(sev, 0) + 1
        # #166: chromatic notes whose enharmonic spelling the active key
        # cannot decide — surfaced for review instead of guessed.
        issues.extend(
            _spelling_issues(
                tuple(n for p in built.payload.parts for n in p.notes),
                payload.key_signature.fifths,
                payload.key_changes,
                built.note_onset_sec,
                score_revision,
                chord_map,
                prefer_flats,
            )
        )
        # #423: audio-evidence boundary re-scoring - a missed
        # re-articulation (split), a phantom edge (merge), or an
        # unprovable one (uncertain) surfaces as a one-click score
        # fix instead of a silent quantizer artifact.
        issues.extend(
            _boundary_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                event_by_id,
                estimate.warp,
                beat_ql,
                score_revision,
                selection_offset_sec,
            )
        )
        # #264: low-octave audit — the same detected-on stem evidence.
        # A tracker that locked onto the 2nd harmonic left the note an
        # octave too high; the spectrum proves it (real fundamental +
        # odd harmonic at -12), but octave doubling is identical so the
        # score keeps the pitch and the flag carries the -12 remedy.
        issues.extend(
            _octave_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                estimate.warp,
                beat_ql,
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                score_revision,
                selection_offset_sec,
                arbiter_events=arbiter_events,
                arbiter_backend=arbiter_backend,
            )
        )
        # #264: isolated semitone dips — a short chromatic note one
        # semitone off a diatonic neighbour, inside a diatonic line,
        # is a tracker bin-snap until proven sung. Same detected-on
        # stem buffer arbitrates when the span allows a reading.
        issues.extend(
            _pitch_dip_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                payload.key_signature.fifths,
                payload.key_changes,
                score_revision,
                selection_offset_sec,
            )
        )
        # #419: chord segments whose chroma the estimator cannot
        # back up - the harmony context rides the issue as evidence
        # (suggested chord + runner-up), there is no auto-fix.
        issues.extend(
            _chord_issues(
                chord_map,
                tuple(n for p in built.payload.parts for n in p.notes),
                estimate.warp,
                beat_ql,
                score_revision,
                prefer_flats,
            )
        )
        if meter_uncertain:
            # Whole-piece issue: auto meter could not justify its pick.
            # `meter_conflict` copy exists in the UI deck.
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.METER_CONFLICT,
                    severity=Severity.CAUTION,
                    evidence={
                        # The rejected guess, not the written 4/4 —
                        # the user needs to see what the estimator
                        # nearly picked to judge the fallback.
                        "estimatedMeter": meter_est_label
                        or f"{meter.numerator}/{meter.denominator}",
                        "meterConfidence": round(meter_confidence, 3),
                        # The ambiguity the confidence margin describes —
                        # '4/4 vs 2/4 by a coin flip' is actionable in a
                        # way 'confidence 0' alone is not (#264).
                        "runnerUpMeter": meter_runner_up,
                    },
                )
            )
        # #358: a wrong anacrusis ripples into every barline, rest
        # grouping, tie decomposition and the measure-level tempo/key
        # maps — a heuristic pickup never writes silently when the
        # evidence cannot justify it.
        pickup_uncertain = pickup_uncertainty(estimate)
        if pickup_uncertain is not None:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.PICKUP_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence=pickup_uncertain,
                )
            )
        # #352: a wrong key ripples into the signature, enharmonic
        # spelling and the Horn-in-F transposition — never write a
        # low-confidence or two-candidate estimate silently.
        # #53: a pinned key is user attestation — certainty by
        # definition, so no uncertainty issue can fire.
        key_uncertain = key_uncertainty(key_analysis) if key_analysis is not None else None
        if key_uncertain is not None:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.KEY_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence=key_uncertain,
                )
            )
        if voice_split is not None:
            # #85 voices texture: overlaps were kept as a second part —
            # report what the split saw (second-voice note count + notes
            # beyond two voices that had to be dropped).
            extra_counts = [len(v) for v in voice_split.voices[1:]]
            if any(extra_counts) or voice_split.dropped_beyond_voices:
                issues.append(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(),
                        time_range=analysis_range,
                        reason=ReviewReason.OVERLAPPING_CANDIDATES,
                        severity=Severity.CAUTION,
                        evidence={
                            "secondVoiceNotes": extra_counts[0],
                            "extraVoiceNotes": sum(extra_counts),
                            "voiceCounts": [len(voice_split.voices[0])] + extra_counts,
                            "droppedBeyondVoices": voice_split.dropped_beyond_voices,
                            "note": (
                                "overlapping pitches were kept as extra parts"
                                if params.texture == "voices"
                                else "overlapping pitches were kept as chords/voices in one part"
                            ),
                        },
                    )
                )
        elif cleaned.polyphonic_overlaps:
            # The monophonic contract silently collapsed real overlaps —
            # warn so the user knows a second voice may have been lost.
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.OVERLAPPING_CANDIDATES,
                    severity=Severity.CAUTION,
                    evidence={
                        "polyphonicOverlaps": cleaned.polyphonic_overlaps,
                        "note": "overlapping pitches were merged into a single line",
                        # #148: auto detected a real mix — the voices
                        # texture would keep those lines as separate
                        # parts, so the UI offers a one-click re-run.
                        "suggestVoicesTexture": mix_suggest_voices,
                        # #314: for a lead-vocal mix (the common JPOP
                        # case) the better remedy is isolating the
                        # vocal first — offered alongside voices only
                        # when isolation was not already used.
                        "suggestVocalIsolation": (
                            # #204: an isolation that ran (opt-in or
                            # auto-rescue) already applied the remedy —
                            # and one the user already asked for is
                            # reported by its own issue, so re-suggesting
                            # would be noise either way.
                            mix_suggest_voices and vocal_path is None and not params.vocal_isolation
                        ),
                    },
                )
            )
        # #181: pYIN is a monophonic tracker — under voices/auto the
        # user asked for (or allowed) polyphony, so surface that the
        # result is one line by construction.
        # #316: when vocal isolation fed pYIN a genuinely monophonic
        # vocal the tracker was the *right* engine — the one-line
        # result is intentional, not a collapsed-mix warning — but
        # only for single-line textures; voices/chords still warn.
        if (
            resolved_pyin
            and params.texture in ("voices", "chords", "auto")
            and (vocal_path is None or params.texture in ("voices", "chords"))
        ):
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.MONOPHONIC_BACKEND,
                    severity=(
                        Severity.WARNING
                        if params.texture in ("voices", "chords")
                        else Severity.CAUTION
                    ),
                    evidence={
                        "backend": "pyin",
                        "texture": params.texture,
                        # Offer the one-click remedy: re-run with the
                        # polyphonic-capable default backend.
                        "suggestBasicPitch": True,
                    },
                )
            )
        # #134 swing issue — the estimate was computed above (it also
        # lands on the payload as swing_feel for the notation).
        # #187: vocal-isolation provenance — the option is opt-in, so
        # the result must say whether the backend actually saw the
        # isolated estimate (info) or fell back to the raw mix and why
        # (caution). Never silent either way.
        if vocal_reason == "applied":
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.VOCAL_ISOLATION_APPLIED,
                    severity=Severity.INFO,
                    evidence={"stage": vocal_method or "center_extraction"},
                )
            )
            # #191: buried-lead honesty — a missed note can never be its
            # own review item, so when the isolated estimate carries
            # only a small share of the source's energy we surface the
            # possibility itself. demucs stems carry near-true vocal
            # energy (the -9.5 dB lead of #165 reads ~0.33), while a
            # center extraction attenuates even healthy leads
            # (side-channel loss + soft mask) — separate bars.
            if vocal_path is not None and len(samples):
                estimate_rms = wav_rms(vocal_path)
                source_rms = _samples_rms(samples)
                if estimate_rms is not None and source_rms > 0:
                    ratio = estimate_rms / source_rms
                    threshold = _LOW_LEAD_RMS_RATIO.get(vocal_method, _LOW_LEAD_RMS_RATIO_DEFAULT)
                    if ratio < threshold:
                        issues.append(
                            ReviewIssue(
                                id="",
                                score_revision=score_revision,
                                canonical_note_ids=(),
                                time_range=analysis_range,
                                reason=ReviewReason.LOW_LEAD_LEVEL,
                                severity=Severity.CAUTION,
                                evidence={
                                    "sourceRms": round(source_rms, 5),
                                    "vocalRms": round(estimate_rms, 5),
                                    "ratioDb": round(20.0 * math.log10(ratio), 1),
                                    "method": vocal_method or "center_extraction",
                                    # #222: the remedy depends on what
                                    # already ran — the requested demucs
                                    # tier + engine-side availability let
                                    # the UI pick between an addon-install
                                    # hint, a precision-tier retry, or a
                                    # plain listen-and-fix message.
                                    "tier": params.vocal_isolation_quality,
                                    "demucsAvailable": demucs_available(),
                                    "suggestPrecisionIsolation": (
                                        vocal_method == "demucs"
                                        and params.vocal_isolation_quality != "precision"
                                    ),
                                },
                            )
                        )
        elif vocal_reason in (
            "mono_source",
            "unavailable",
            # #322: requested but skipped — voices/chords keep the
            # overlapping lines, so isolation would defeat the texture.
            "polyphonic_texture",
        ):
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.VOCAL_ISOLATION_UNAVAILABLE,
                    severity=Severity.CAUTION,
                    evidence={"detail": vocal_reason},
                )
            )
        # #212: the accompaniment staff is separation-derived — the
        # detection there is necessarily rougher than the lead line's,
        # so the whole part gets ONE provenance marker instead of
        # per-note flags (which would double the review list).
        if accomp_alternatives:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.ACCOMPANIMENT_PART,
                    severity=Severity.INFO,
                    evidence={
                        # Read the emitted names off the document — the
                        # issue's part list can never drift from the
                        # staves the user actually sees.
                        "partNames": [
                            p.name for p in built.payload.parts if not p.transposing
                        ],
                        "method": vocal_method or "none",
                    },
                )
            )
        # #188: the tracked tempo looks like a half/double pick —
        # surface it with the corrected value so the UI can offer a
        # one-click setTempo.
        if tempo_octave is not None and tempo_octave.suggestion:
            suggested = (
                estimate.median_bpm * 2.0
                if tempo_octave.suggestion == "double"
                else estimate.median_bpm / 2.0
            )
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.TEMPO_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "estimatedBpm": round(estimate.median_bpm, 1),
                        "suggestedBpm": round(suggested, 1),
                        "direction": tempo_octave.suggestion,
                    },
                )
            )
        if swing_est.detected:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.SWING_FEEL,
                    severity=Severity.CAUTION,
                    evidence={
                        "offbeatOnsets": swing_est.offbeats,
                        "swingOnsets": swing_est.swing,
                        "tripletOnsets": swing_est.triplet,
                        "straightOnsets": swing_est.straight,
                        "swingRatio": round(swing_est.swing_ratio, 3),
                    },
                )
            )
        # Deterministic renumber across the merged set.
        issues.sort(key=lambda i: (i.time_range.start_sec, i.reason.value))
        allocator = IssueIdAllocator()
        issues = [replace(issue, id=allocator.allocate()) for issue in issues]
        # #360: deferred extras need real ids too — they were sliced
        #  out before the renumber, so continue the same allocator or
        #  the desktop's lazy expansion meets empty/duplicate ids.
        omitted_extras = [replace(issue, id=allocator.allocate()) for issue in omitted_extras]
        if stop(5):
            return

        # ---- rendering -------------------------------------------------
        stage(6)
        musicxml_concert = export_concert_musicxml(document)
        # #385: three exports plus five per-part verification passes -
        # every unit is a real completed check, nothing estimated.
        render_total = 3 + 5 * len(payload.parts)
        render_done = 0
        step(6, 1, render_total)
        musicxml_horn = export_horn_in_f_musicxml(document)
        step(6, 2, render_total)
        # #156: the B-flat view is a third artifact — same canonical
        # document, +M2 projection, -M2 <transpose> declaration.
        musicxml_b_flat = export_b_flat_musicxml(document)
        step(6, 3, render_total)

        # The export path is verified, not trusted: read the emitted
        # MusicXML back and compare committed rhythm per part (multi-
        # voice scores verify every part, not just the first).
        from hornscribe.export.musicxml import (  # noqa: PLC0415
            verify_rhythm_roundtrip,
            verify_written_projection,
        )

        rhythm_problems: list[str] = []
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_concert, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        # #370: the Horn in F file is the product's main artifact — it
        # gets the same structural round-trip plus the written->sounding
        # projection invariant (transpose block, per-note pitch
        # recovery, written key = canonical key +1 fifth). Corruption
        # that parses but transposes wrong used to ship silently.
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"hornF part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_horn, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"hornF part {pi}: {p}"
                for p in verify_written_projection(
                    document,
                    musicxml_horn,
                    PitchSpace.WRITTEN_HORN_F,
                    part_index=pi,
                )
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        # #156: the B-flat view gets the identical structural +
        # projection verification - a third artifact is only useful
        # when it is held to the same contract as the F-horn file.
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"bFlat part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_b_flat, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"bFlat part {pi}: {p}"
                for p in verify_written_projection(
                    document,
                    musicxml_b_flat,
                    PitchSpace.WRITTEN_B_FLAT,
                    part_index=pi,
                )
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        if rhythm_problems:
            # Late verification issue: allocate an id like the others
            # (issue ids were already renumbered above — keep them
            # unique by continuing the same allocator).
            issues.append(
                replace(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(),
                        time_range=analysis_range,
                        reason=ReviewReason.STRUCTURAL_MEASURE_CONFLICT,
                        severity=Severity.WARNING,
                        evidence={
                            "rhythmRoundtripProblems": rhythm_problems[:10],
                        },
                    ),
                    id=allocator.allocate(),
                ),
            )

        emit(
            "completed",
            stage=STAGES[6],
            progress=1.0,
            result={
                "scoreRevision": str(score_revision),
                "scoreDocument": document.to_dict(),
                "reviewIssues": [i.to_dict() for i in issues],
                # #360: cap-omitted detections stay in the result — the
                #  desktop lazily expands them into the review list
                #  (ids were allocated at detection, so they are stable).
                "omittedReviewIssues": [i.to_dict() for i in omitted_extras],
                "musicXmlConcert": musicxml_concert,
                "musicXmlHornF": musicxml_horn,
                "musicXmlBFlat": musicxml_b_flat,
                "meta": {
                    "backend": backend_id,
                    "backendVersion": backend_version,
                    # #100: project.save needs the tr-* id for the
                    # TranscriptionRecord in .hornscribe.json.
                    "transcriptionRevision": str(revision),
                    "audioPath": params.audio_path,
                    "durationSec": round(duration_sec, 3),
                    # #319: the effective pre-backend chain — which
                    # isolation method+version (or why it did not run)
                    # produced the audio the backend saw. Absent when
                    # no preprocessing was requested.
                    **({"preprocess": preprocess} if preprocess is not None else {}),
                    "tempoBpm": round(estimate.median_bpm, 2),
                    "tempoAuto": estimate.auto,
                    "meter": f"{meter.numerator}/{meter.denominator}",
                    "meterEstimated": meter_estimated,
                    "meterConfidence": round(meter_confidence, 3),
                    "keyFifths": key.fifths,
                    "keyMode": key.mode,
                    "keyConfidence": round(key_confidence, 3),
                    # #53: True when the user pinned the key — an
                    # estimate and an attestation must not read alike.
                    "keyHinted": key_hint_sig is not None,
                    # #419: measure-segmented chord map - consecutive
                    # same-chord spans merged for readability.
                    "chordProgression": _merged_chord_dicts(chord_map, prefer_flats),
                    "noteCount": sum(len(p.notes) for p in payload.parts),
                    "partCount": len(payload.parts),
                    "pickupBeats": str(payload.pickup_beats),
                    "alignmentShiftSec": round(shift, 4),
                    "alignmentMeterResolved": bool(best.diagnostics.alignment_meter_resolved),
                    "reviewReasons": list(best.diagnostics.review_reasons),
                    # #272: the surfacing cap is never silent — how
                    # many detected issues were left out, by severity.
                    "reviewSummary": {
                        "surfaced": len(issues),
                        "omitted": len(omitted_extras),
                        "omittedBySeverity": omitted_by_severity,
                    },
                    "cleaning": (
                        voice_split.stats() if voice_split is not None else cleaned.stats()
                    ),
                    # #244: accompaniment-side filtering is separate
                    # from the lead-cleaning counters above -- the
                    # drop count tells reviewers how much flicker the
                    # confidence floor removed.
                    "accompanimentCleaning": {
                        "confidenceDropped": accomp_conf_dropped,
                        "voiceCount": len(accomp_cleaned),
                        "eventCount": sum(
                            len(c.events) for c in accomp_cleaned
                        ),
                    },
                    "settings": params.settings_dict(),
                },
            },
        )
    except EngineDependencyError as exc:
        emit(
            "failed",
            error={
                "code": ERR_ENGINE_DEPENDENCY_MISSING,
                "message": str(exc),
                "details": {"package": exc.package},
            },
        )
    except UnsupportedMeterError as exc:
        emit(
            "failed",
            error={"code": ERR_JOB_FAILED, "message": str(exc)},
        )
    except ValueError as exc:
        emit(
            "failed",
            error={"code": ERR_JOB_FAILED, "message": str(exc)},
        )
