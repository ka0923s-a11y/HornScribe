"""The ``transcription`` job: audio file -> canonical score (ENG-002).

Staged exactly as the UI progress contract (GUI_UX_SPEC §5,
``TRANSCRIPTION_STAGE_IDS``) — every stage emits a ``progress`` event
carrying ``stage`` so the transcribing screen never has to guess:

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
from collections.abc import Callable
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Any

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, ScoreNoteId, ScoreRevisionId
from hornscribe.domain.review import (
    IssueIdAllocator,
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.domain.score import KeyChange, QuantizedNote
from hornscribe.export.musicxml import (
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
    require_module,
)
from .clean import (
    MERGE_GAP_SEC,
    clean_monophonic,
    clip_to_range,
    split_voices,
)
from .key import estimate_key, estimate_key_segments
from .meter import estimate_meter
from .options import TranscriptionParams
from .scorebuild import build_score
from .swing import detect_swing
from .tempo import estimate_tempo, tempo_map_from_estimate
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

# ``auto`` texture: when the onset-clean pass still saw this many
# different-pitch overlaps (absolute floor + share of surviving events),
# the source is a mix, not a monophonic line — re-clean keeping the top
# voice so the melody survives instead of being clipped by accompaniment.
AUTO_TEXTURE_MIN_OVERLAPS = 4
AUTO_TEXTURE_OVERLAP_RATIO = 0.05

EventEmitter = Callable[..., None]
NoteBackend = Callable[[str], tuple[RawNoteEvent, ...]]
AudioLoader = Callable[[str], tuple[Any, int]]


def _track_beats(
    samples: Any, sample_rate: int
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """Beat times + onset strength sampled at each beat (librosa).

    Shared by the meter estimator (needs strengths at beats) and the
    tempo warp (needs the beat times themselves). A failed or empty
    track returns empty tuples — callers degrade to the 4/4 default.
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency

    onset_env = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    _tempo, beat_frames = librosa.beat.beat_track(
        y=samples, sr=sample_rate, onset_envelope=onset_env, units="frames"
    )
    times: list[float] = []
    strengths: list[float] = []
    for frame in beat_frames:
        ft = float(librosa.frames_to_time(frame, sr=sample_rate))
        if times and ft <= times[-1]:
            continue
        idx = int(frame)
        strength = (
            float(onset_env[idx]) if 0 <= idx < len(onset_env) else 0.0
        )
        times.append(ft)
        strengths.append(strength)
    return tuple(times), tuple(strengths)


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
                },
            )
        )
    return issues


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

    def stage(index: int, progress: float) -> None:
        emit("progress", stage=STAGES[index], progress=progress)

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

    emit("started", stage=STAGES[0], progress=0.0)
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
        samples, sample_rate = (loader or load_mono_audio)(params.audio_path)
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
        stage(1, 0.15)
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
            )
        if vocal_path is None and params.range_kind == "selection":
            staged_path = _stage_selection_wav(samples, sample_rate)
        backend_path = vocal_path or staged_path or params.audio_path
        # #189: "auto" picks the engine that fits the declared
        # texture — a declared-mono source gets the monophonic
        # tracker; mixes keep the polyphonic model.
        # #316: a successfully isolated vocal is itself monophonic —
        # the singing-voice tracker is the right engine for it, not
        # the polyphonic model. voices/chords keep the polyphonic
        # model (the user asked for every line); an explicit backend
        # pin still wins over everything.
        resolved_pyin = params.backend == "pyin" or (
            params.backend == "auto"
            and (
                params.texture == "mono"
                or (
                    vocal_path is not None
                    and params.texture not in ("voices", "chords")
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

                backend_version = librosa.__version__
            except Exception:
                backend_version = "unknown"
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
        if backend is not None:
            run_backend = backend
        else:
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
            if resolved_pyin:
                # #175: monophonic tracker — better for a single sung line.
                run_backend = lambda path: predict_note_events_pyin(  # noqa: E731
                    path,
                    revision=revision,
                    **({"max_frequency_hz": max_hz} if max_hz else {}),
                )
            else:
                run_backend = lambda path: predict_note_events(  # noqa: E731
                    path,
                    revision=revision,
                    **({"max_frequency_hz": max_hz} if max_hz else {}),
                )
        try:
            raw_events = run_backend(backend_path)
        finally:
            if staged_path is not None:
                with contextlib.suppress(OSError):
                    os.unlink(staged_path)
            if vocal_path is not None and not vocal_managed:
                with contextlib.suppress(OSError):
                    os.unlink(vocal_path)
        if staged_path is not None or vocal_path is not None:
            raw_events = _shift_event_times(raw_events, selection_offset_sec)
        if stop(1):
            return

        # ---- cleaning --------------------------------------------------
        stage(2, 0.55)
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
        voice_split = None
        if params.texture in ("voices", "chords"):
            # #85: keep up to three detected lines as separate parts —
            # a triad survives as three voices instead of dropping the
            # lowest note.  #155: the chords texture splits the same
            # way, then merges the voices into one part at build time.
            voice_split = split_voices(ranged, max_voices=3)
            cleaned = clean_monophonic(
                voice_split.voices[0], merge_gap_sec=clean_merge_gap
            )
            cleaned_lowers = [
                clean_monophonic(v, merge_gap_sec=clean_merge_gap)
                for v in voice_split.voices[1:]
            ]
        else:
            cleaned = clean_monophonic(
                ranged,
                merge_gap_sec=clean_merge_gap,
                prefer=prefer,
            )
            cleaned_lowers = []
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
                )
                auto_mix_detected = True
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
        stage(3, 0.65)
        meter = params.meter_segment()
        meter_estimated = False
        meter_uncertain = False
        pulse_unit_ql: Fraction | None = None
        # #229: the beat track runs on the slice, so it must also run
        # whenever estimate_tempo would track internally on the slice —
        # a pinned meter + auto tempo + selection would otherwise mix
        # slice-relative beat anchors with absolute event times and
        # misplace the whole warp. Shifted beats are absolute seconds,
        # matching the events.
        need_beats = params.meter == "auto" or (
            params.tempo_bpm is None and selection_offset_sec > 0.0
        )
        if need_beats:
            tracked_times, strengths = _track_beats(samples, sample_rate)
            beat_times = tuple(t + selection_offset_sec for t in tracked_times)
        else:
            beat_times = None
            strengths = ()
        if params.meter == "auto":
            # #228: auto meter reads accents off a beat track — run it
            # even when the user pinned the tempo (the pinned BPM only
            # replaces the warp; the accent evidence is still real).
            # The same track feeds the tempo warp when tempo is auto.
            meter_est = estimate_meter(beat_times or (), strengths)
            meter = MeterSegment(
                start_ql=Fraction(0),
                numerator=int(meter_est.meter.split("/")[0]),
                denominator=int(meter_est.meter.split("/")[1]),
            )
            meter_estimated = True
            meter_uncertain = meter_est.uncertain
            meter_confidence = meter_est.confidence
            if meter_est.tracked_eighths:
                pulse_unit_ql = Fraction(4, meter.denominator)
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
        )
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
        stage(4, 0.75)
        profile = params.quantization_profile()
        alternatives = quantize_events(
            cleaned.events, estimate.warp, meter_map, profile
        )
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
        if stop(4):
            return

        # ---- building_score -------------------------------------------
        stage(5, 0.9)
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
        if len(measure_starts) >= 5:
            key, key_changes, key_confidence = estimate_key_segments(
                tuple(key_pitches),
                tuple(key_onsets),
                tuple(key_durations),
                tuple(measure_starts),
            )
        else:
            key, key_confidence = estimate_key(
                tuple(key_pitches), tuple(key_durations)
            )
            key_changes = ()
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
        )
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
                        "estimatedMeter": f"{meter.numerator}/{meter.denominator}",
                        "meterConfidence": round(meter_confidence, 3),
                    },
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
        if stop(5):
            return

        # ---- rendering -------------------------------------------------
        stage(6, 0.96)
        musicxml_concert = export_concert_musicxml(document)
        musicxml_horn = export_horn_in_f_musicxml(document)

        # The export path is verified, not trusted: read the emitted
        # MusicXML back and compare committed rhythm per part (multi-
        # voice scores verify every part, not just the first).
        from hornscribe.export.musicxml import (  # noqa: PLC0415
            verify_rhythm_roundtrip,
        )
        rhythm_problems = [
            f"part {pi}: {p}"
            for pi in range(len(payload.parts))
            for p in verify_rhythm_roundtrip(
                document, musicxml_concert, part_index=pi
            )
        ]
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
                "musicXmlConcert": musicxml_concert,
                "musicXmlHornF": musicxml_horn,
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
                    "noteCount": sum(len(p.notes) for p in payload.parts),
                    "partCount": len(payload.parts),
                    "pickupBeats": str(payload.pickup_beats),
                    "alignmentShiftSec": round(shift, 4),
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
