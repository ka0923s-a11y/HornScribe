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
    boundary_flags,
    compute_envelopes,
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
from .vocal import vocal_wav

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
MAX_CHORD_ISSUES = 10
"""Cap on chord-uncertainty segments (#419) - a harmonically muddy
piece flags its worst spans, not every bar."""

# ``auto`` texture: when the onset-clean pass still saw this many
# different-pitch overlaps (absolute floor + share of surviving events),
# the source is a mix, not a monophonic line — re-clean keeping the top
# voice so the melody survives instead of being clipped by accompaniment.
AUTO_TEXTURE_MIN_OVERLAPS = 4
AUTO_TEXTURE_OVERLAP_RATIO = 0.05

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


def _track_beats(
    samples: Any, sample_rate: int
) -> tuple[tuple[float, ...], tuple[float, ...]]:
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
            strength = (
                float(onset_env[s_idx])
                if 0 <= s_idx < len(onset_env)
                else 0.0
            )
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
                    librosa.frames_to_time(
                        _refine_beat_frame(onset_env, peak), sr=sample_rate
                    )
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


def _tempo_regions(
    onset_env: Any, sample_rate: int
) -> list[tuple[float, float, float]]:
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
        librosa.feature.tempo(
            onset_envelope=onset_env, sr=sample_rate, aggregate=None
        ),
        dtype=float,
    )
    dyn = dyn[np.isfinite(dyn) & (dyn > 0)]
    return _tempo_regions_from_dyn(dyn, 512.0 / float(sample_rate))


def _tempo_regions_from_dyn(
    dyn: Any, frame_sec: float
) -> list[tuple[float, float, float]]:
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

    regions: list[list[float]] = []
    run = [float(dyn[0])]
    start = 0
    for i in range(1, len(dyn)):
        mean = float(np.mean(run))
        v = float(dyn[i])
        if mean > 0 and abs(v - mean) / mean > _TEMPO_PLATEAU_BAND:
            regions.append([start * frame_sec, i * frame_sec, mean])
            run = [v]
            start = i
        else:
            run.append(v)
    regions.append(
        [start * frame_sec, len(dyn) * frame_sec, float(np.mean(run))]
    )

    # Fold too-short regions into the tempo-nearer neighbour.
    changed = True
    while changed and len(regions) > 1:
        changed = False
        for i, r in enumerate(regions):
            if r[1] - r[0] >= _TEMPO_REGION_MIN_SEC:
                continue
            left = regions[i - 1] if i > 0 else None
            right = regions[i + 1] if i + 1 < len(regions) else None
            if left is None and right is None:
                break
            merge_left = left is not None and (
                right is None
                or abs(left[2] - r[2]) <= abs(right[2] - r[2])
            )
            if merge_left and left is not None:
                left[1] = r[1]
                left[2] = (left[2] + r[2]) / 2.0
                regions.pop(i)
            elif right is not None:
                right[0] = r[0]
                right[2] = (right[2] + r[2]) / 2.0
                regions.pop(i)
            else:
                break
            changed = True
            break
    if len(regions) < 2:
        return []
    return [(r[0], r[1], r[2]) for r in regions]


def _event_accents(
    events: Iterable[RawNoteEvent],
    samples: Any,
    sample_rate: int,
) -> tuple[tuple[float, float], ...]:
    """(onset_sec, post-onset RMS) per event -- meter accent evidence.

    The tracker's onset envelope is too noisy to read performed
    accents (#87), but the audio energy in a short window after each
    detected onset tracks them closely. Pure-Python RMS keeps this a
    no-op on engines without numpy.
    """
    window = int(0.12 * sample_rate)
    out: list[tuple[float, float]] = []
    n = len(samples)
    for ev in events:
        i0 = max(0, int(ev.onset_sec * sample_rate))
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
            pitch_bends=tuple(
                replace(b, time_sec=b.time_sec + offset_sec)
                for b in ev.pitch_bends
            ),
        )
        for ev in events
    )


def _stage_selection_wav(
    samples: Any, sample_rate: int
) -> str | None:
    """Write *samples* to a temp PCM16 WAV; return its path or None.

    #229: both backends take a file path, so a sliced selection is
    staged on disk. The caller deletes the file after inference.
    """
    try:
        pcm = array(
            "h",
            (
                max(-32768, min(32767, int(round(float(v) * 32768.0))))
                for v in samples
            ),
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
                    severity=(
                        Severity.WARNING if conf < 0.3 else Severity.CAUTION
                    ),
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
                        Severity.WARNING
                        if status is HornRangeStatus.EXTREME
                        else Severity.CAUTION
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
            (
                c
                for c in chord_map
                if c.start_sec <= onset < c.end_sec
            ),
            None,
        )
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=tuple(
                    n.id for n in notes[:_MAX_SPELLING_NOTE_IDS]
                ),
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
        for flag in boundary_flags(
            samples, sample_rate, c.events, time_offset_sec=time_offset_sec
        ):
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
                severity = (
                    Severity.CAUTION if flag.kind == "merge" else Severity.INFO
                )
                note_ids.extend((a.id, b.id))
            ev_a = event_by_id.get(flag.event_ids[0])
            ev_b = (
                event_by_id.get(flag.event_ids[1])
                if len(flag.event_ids) > 1
                else None
            )
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
                    time_range=TimeRange(
                        start_sec=max(0.0, lo), end_sec=hi
                    ),
                    reason=ReviewReason.BOUNDARY_UNCERTAIN,
                    severity=severity,
                    evidence=evidence,
                )
            )
    _rank = {Severity.CAUTION: 0, Severity.INFO: 1}
    issues.sort(
       key=lambda i: (_rank.get(i.severity, 2), i.time_range.start_sec)
    )
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
        if est.confidence >= CHORD_LOW_CONFIDENCE and (
            est.margin >= CHORD_LOW_MARGIN
        ):
            continue
        ids = tuple(
            nid
            for sec, nid in note_secs
            if est.start_sec <= sec < est.end_sec
        )[:6]
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
        if (
            out
            and out[-1]["rootPc"] == est.root_pc
            and out[-1]["quality"] == est.quality
        ):
            out[-1]["endSec"] = round(est.end_sec, 3)
            out[-1]["confidence"] = round(
                min(out[-1]["confidence"], est.confidence), 3
            )
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
) -> tuple[bool, float, tuple[RawNoteEvent, ...]]:
    """Run pYIN and rescued Basic Pitch on the isolated estimate and
    return ``(adopt_pyin, agreement, events)`` (#165).

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
    bp_events = predict_note_events_rescued(
        backend_path, revision=bp_revision, **hz_kwargs
    )
    pyin_events = predict_note_events_pyin(
        backend_path, revision=pyin_revision, **hz_kwargs
    )
    # The arbitration line mirrors the downstream clean — the gate
    # asks "did the tracker follow THE LINE", so the comparison
    # line is built with the texture's own overlap rule.
    bp_line = clean_monophonic(
        bp_events, merge_gap_sec=MERGE_GAP_SEC, prefer=prefer
    ).events
    agreement = lead_track_agreement(bp_line, pyin_events)
    adopt_pyin = agreement >= LEAD_GATE_MIN_AGREEMENT or (
        not bp_line and bool(pyin_events)
    )
    return adopt_pyin, agreement, (
        pyin_events if adopt_pyin else bp_events
    )


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
                params.selection_end_sec
                if params.selection_end_sec is not None
                else duration_sec
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
            vis_lo = (
                params.selection_start_sec or 0.0
                if params.range_kind == "selection"
                else 0.0
            )
            vis_hi = (
                params.selection_end_sec
                if params.range_kind == "selection"
                else None
            )
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
            if vocal_path is not None:
                # Isolation produced the backend input — the staging
                # unit below is no longer part of the plan.
                transcribe_total -= int(
                    params.range_kind == "selection"
                )
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
        if params.vocal_isolation:
            preprocess = {
                "vocalIsolation": True,
                "method": vocal_method or "none",
                "methodVersion": vocal_method_version,
                # Why isolation did not apply (mono_source /
                # unavailable) — absent on a successful run.
                **(
                    {"fallbackReason": vocal_reason}
                    if vocal_path is None and vocal_reason
                    else {}
                ),
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
        max_hz = (
            MELODY_MAX_FREQUENCY_HZ
            if params.texture != "mono"
            else None
        )
        hz_kwargs: dict[str, Any] = (
            {"max_frequency_hz": max_hz} if max_hz else {}
        )
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
                adopt_pyin, agreement, gate_events = _lead_track_gate(
                    backend_path,
                    bp_revision=revision,
                    pyin_revision=pyin_revision,
                    hz_kwargs=hz_kwargs,
                    prefer="top"
                    if params.texture == "melody"
                    else "onset",
                )
                raw_events = gate_events
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
        step(1, transcribe_done + 1, transcribe_total)
        if stop(1):
            return

        # ---- cleaning --------------------------------------------------
        stage(2)
        ranged = clip_to_range(
            raw_events, params.selection_start_sec, params.selection_end_sec
        )
        prefer = "top" if params.texture == "melody" else "onset"
        # #180: pyin already bridges tracker dropouts and splits real
        # re-articulations at onset times — re-merging same-pitch
        # neighbours inside clean_monophonic would undo that split.
        clean_merge_gap = (
            0.0 if resolved_pyin else MERGE_GAP_SEC
        )
        # Octave-flicker repair evidence: when the neighbour pitch-class
        # rule proposes snapping a note across an octave, the note's own
        # spectrum arbitrates — a played octave figure carries its real
        # fundamental, a tracker flicker does not (octave-leaps-4-4:
        # honest C4->C5->C4 figures were being flattened).  The verdict
        # reads the analysis buffer, so event times map back through
        # selection_offset_sec exactly like the seam envelopes do.
        def _octave_ev(ev: RawNoteEvent, target: float) -> bool:
            return octave_prefers(
                samples,
                sample_rate,
                ev.onset_sec,
                ev.offset_sec,
                ev.pitch_midi,
                target,
                time_offset_sec=selection_offset_sec,
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
                edge_env = compute_envelopes(
                    samples,
                    sample_rate,
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
        auto_mix_detected = False
        if params.texture == "auto" and cleaned.events:
            overlap_ratio = cleaned.polyphonic_overlaps / len(cleaned.events)
            if (
                cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
                and overlap_ratio >= AUTO_TEXTURE_OVERLAP_RATIO
            ):
                # Mix detected — keep the melody line instead of clipping it.
                cleaned = clean_monophonic(
                    ranged,
                    merge_gap_sec=clean_merge_gap,
                    prefer="top",
                    octave_verdict=_octave_ev,
                )
                auto_mix_detected = True
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
            and cleaned.polyphonic_overlaps / len(cleaned.events)
            >= AUTO_TEXTURE_OVERLAP_RATIO
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
        if stop(2):
            return

        # ---- analyzing_rhythm -----------------------------------------
        stage(3)
        meter = params.meter_segment()
        meter_estimated = False
        meter_uncertain = False
        meter_est_label: str | None = None
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
                samples,
                sample_rate,
            )
            meter_est = estimate_meter(
                beat_times or (), strengths, event_accents=accents
            )
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
                measure_phase_ql=(
                    meter.measure_length_ql - estimate.pickup_len_ql
                ),
            )
        meter_map = MeterMap((meter,))
        if stop(3):
            return

        # ---- quantizing ------------------------------------------------
        stage(4)
        profile = params.quantization_profile()
        alternatives = quantize_events(
            cleaned.events, estimate.warp, meter_map, profile
        )
        # #385: one real unit per quantized voice.
        quantize_total = 1 + sum(
            1 for c in cleaned_lowers if c.events
        )
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

        # ---- building_score -------------------------------------------
        stage(5)
        # #385: counted sub-steps — key analysis, swing census, tempo
        # octave census (auto tempo only), build_score, evidence doc.
        build_done = 0
        build_total = 4 + int(estimate.auto)
        event_by_id: dict[RawNoteEventId, RawNoteEvent] = {
            e.id: e for e in cleaned.events
        }
        for cleaned_lower in cleaned_lowers:
            for e in cleaned_lower.events:
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
        last_onset = max(
            (n.onset_ql / beat_ql for n in best.notes), default=Fraction(0)
        )
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
                lo_s = (
                    estimate.warp.ql_to_seconds(lo_b * beat_ql)
                    - selection_offset_sec
                )
                hi_s = (
                    estimate.warp.ql_to_seconds(hi_b * beat_ql)
                    - selection_offset_sec
                )
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
                    samples,
                    sample_rate,
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
                for (lo_b, hi_b), est in zip(
                    seg_beats, chord_map, strict=True
                )
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
            extra_voices=(
                tuple(alts[0] for alts in lower_alternatives)
            ),
            merge_voices=params.texture == "chords",
            voice_names=(
                # #251: the chords texture is an analytical capture of
                # simultaneous notes, not a one-player part — the part
                # name says so wherever the score is exported.
                ("Horn in F (chords)",)
                if params.texture == "chords"
                else ()
            ),
            key_changes=key_changes,
            swing_feel=(
                swing_est.mean_phase if swing_est.detected else None
            ),
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
        document = replace(
            built.document,
            raw_evidence={
                "transcriptionRevision": str(revision),
                "warp": _warp_evidence(estimate.warp),
                "parts": [
                    {"events": [e.to_dict() for e in evs]}
                    for evs in evidence_parts
                ],
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
        issues.extend(
            _extra_issues(
                tuple(
                    n for p in built.payload.parts for n in p.notes
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
                samples,
                sample_rate,
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                event_by_id,
                estimate.warp,
                beat_ql,
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
        key_uncertain = (
            key_uncertainty(key_analysis) if key_analysis is not None else None
        )
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
                            "voiceCounts": [
                                len(voice_split.voices[0])
                            ] + extra_counts,
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
                            mix_suggest_voices and not params.vocal_isolation
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
            and (
                vocal_path is None
                or params.texture in ("voices", "chords")
            )
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
        issues.sort(
            key=lambda i: (i.time_range.start_sec, i.reason.value)
        )
        allocator = IssueIdAllocator()
        issues = [
            replace(issue, id=allocator.allocate()) for issue in issues
        ]
        # #360: deferred extras need real ids too — they were sliced
        #  out before the renumber, so continue the same allocator or
        #  the desktop's lazy expansion meets empty/duplicate ids.
        omitted_extras = [
            replace(issue, id=allocator.allocate()) for issue in omitted_extras
        ]
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
                for p in verify_rhythm_roundtrip(
                    document, musicxml_concert, part_index=pi
                )
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
                for p in verify_rhythm_roundtrip(
                    document, musicxml_horn, part_index=pi
                )
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
                for p in verify_rhythm_roundtrip(
                    document, musicxml_b_flat, part_index=pi
                )
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
                    **(
                        {"preprocess": preprocess}
                        if preprocess is not None
                        else {}
                    ),
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
                    "chordProgression": _merged_chord_dicts(
                        chord_map, prefer_flats
                    ),
                    "noteCount": sum(len(p.notes) for p in payload.parts),
                    "partCount": len(payload.parts),
                    "pickupBeats": str(payload.pickup_beats),
                    "alignmentShiftSec": round(shift, 4),
                    "alignmentMeterResolved": bool(
                        best.diagnostics.alignment_meter_resolved
                    ),
                    "reviewReasons": list(best.diagnostics.review_reasons),
                    # #272: the surfacing cap is never silent — how
                    # many detected issues were left out, by severity.
                    "reviewSummary": {
                        "surfaced": len(issues),
                        "omitted": len(omitted_extras),
                        "omittedBySeverity": omitted_by_severity,
                    },
                    "cleaning": (
                        voice_split.stats()
                        if voice_split is not None
                        else cleaned.stats()
                    ),
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
