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

import hashlib
import os
import threading
import time
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
from hornscribe.domain.score import QuantizedNote
from hornscribe.export.musicxml import (
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)
from hornscribe.instruments.horn_f import HornRangeStatus, sounding_range_status
from hornscribe.rhythm.issues import generate_review_issues
from hornscribe.rhythm.meter import MeterMap, MeterSegment, UnsupportedMeterError
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.timewarp import normalize_to_score_time
from hornscribe.worker.protocol import (
    ERR_ENGINE_DEPENDENCY_MISSING,
    ERR_JOB_FAILED,
    ERR_JOB_TIMEOUT,
    ERR_NO_PITCHED_CONTENT,
)

from .backend import (
    MELODY_MAX_FREQUENCY_HZ,
    EngineDependencyError,
    load_mono_audio,
    new_transcription_revision,
    predict_note_events,
    require_module,
)
from .clean import clean_monophonic, clip_to_range, split_voices
from .key import estimate_key, estimate_key_segments
from .meter import estimate_meter
from .options import TranscriptionParams
from .scorebuild import build_score
from .swing import detect_swing
from .tempo import estimate_tempo, tempo_map_from_estimate

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
    return issues[:MAX_EXTRA_ISSUES]


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
        if stop(0):
            return

        # ---- transcribing (blocking ONNX call) ------------------------
        stage(1, 0.15)
        revision = new_transcription_revision(
            params.audio_path, params.settings_dict()
        )
        if backend is not None:
            run_backend = backend
        else:
            # Melody-texture jobs widen the detection band: JPOP vocals and
            # mix melodies sit above the 880 Hz horn cap.
            max_hz = (
                MELODY_MAX_FREQUENCY_HZ
                if params.texture == "melody"
                else None
            )
            run_backend = lambda path: predict_note_events(  # noqa: E731
                path,
                revision=revision,
                **({"max_frequency_hz": max_hz} if max_hz else {}),
            )
        raw_events = run_backend(params.audio_path)
        if stop(1):
            return

        # ---- cleaning --------------------------------------------------
        stage(2, 0.55)
        ranged = clip_to_range(
            raw_events, params.selection_start_sec, params.selection_end_sec
        )
        prefer = "top" if params.texture == "melody" else "onset"
        voice_split = None
        if params.texture == "voices":
            # #85: keep up to three detected lines as separate parts —
            # a triad survives as three voices instead of dropping the
            # lowest note.
            voice_split = split_voices(ranged, max_voices=3)
            cleaned = clean_monophonic(voice_split.voices[0])
            cleaned_lowers = [
                clean_monophonic(v) for v in voice_split.voices[1:]
            ]
        else:
            cleaned = clean_monophonic(ranged, prefer=prefer)
            cleaned_lowers = []
        if params.texture == "auto" and cleaned.events:
            overlap_ratio = cleaned.polyphonic_overlaps / len(cleaned.events)
            if (
                cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
                and overlap_ratio >= AUTO_TEXTURE_OVERLAP_RATIO
            ):
                # Mix detected — keep the melody line instead of clipping it.
                cleaned = clean_monophonic(ranged, prefer="top")
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
        if params.meter == "auto" and params.tempo_bpm is None:
            # Auto meter needs the same beat track the tempo warp uses —
            # compute it once here and hand it down.
            beat_times, strengths = _track_beats(samples, sample_rate)
            meter_est = estimate_meter(beat_times, strengths)
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
            beat_times = None
            meter_confidence = 1.0 if params.meter != "auto" else 0.0
            meter_estimated = params.meter == "auto"
            # Auto meter with a user-pinned tempo has no beat track to
            # read accents from — the 4/4 seed is a guess, flag it.
            meter_uncertain = params.meter == "auto"
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
        built = build_score(
            best,
            meter,
            tempo_map,
            key,
            pickup_len_ql=estimate.pickup_len_ql,
            event_by_id=event_by_id,
            title=Path(params.audio_path).stem,
            source_audio_path=params.audio_path,
            source_audio_hash=audio_hash,
            settings=params.settings_dict(),
            extra_voices=(
                tuple(alts[0] for alts in lower_alternatives)
            ),
            key_changes=key_changes,
        )
        payload = built.payload
        score_revision = payload.revision_id()

        # Review issues: quantizer reasons + confidence/range/length.
        shift = best.diagnostics.alignment_shift_sec
        normalized = normalize_to_score_time(
            cleaned.events, estimate.warp, alignment_shift_sec=shift
        )
        issues = list(
            generate_review_issues(
                alternatives,
                normalized,
                meter_map,
                profile,
                score_revision=score_revision,
                warp=estimate.warp,
            )
        )
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
        if meter_uncertain:
            # Whole-piece issue: auto meter could not justify its pick.
            # `meter_conflict` copy exists in the UI deck.
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=TimeRange(
                        start_sec=0.0, end_sec=duration_sec
                    ),
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
                        time_range=TimeRange(
                            start_sec=0.0, end_sec=duration_sec
                        ),
                        reason=ReviewReason.OVERLAPPING_CANDIDATES,
                        severity=Severity.CAUTION,
                        evidence={
                            "secondVoiceNotes": extra_counts[0],
                            "extraVoiceNotes": sum(extra_counts),
                            "voiceCounts": [
                                len(voice_split.voices[0])
                            ] + extra_counts,
                            "droppedBeyondVoices": voice_split.dropped_beyond_voices,
                            "note": "overlapping pitches were kept as extra parts",
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
                    time_range=TimeRange(
                        start_sec=0.0, end_sec=duration_sec
                    ),
                    reason=ReviewReason.OVERLAPPING_CANDIDATES,
                    severity=Severity.CAUTION,
                    evidence={
                        "polyphonicOverlaps": cleaned.polyphonic_overlaps,
                        "note": "overlapping pitches were merged into a single line",
                    },
                )
            )
        # #134 swing feel: census the normalized offbeat onsets — a
        # dominant 2/3-of-beat cluster with a quiet 1/3 cluster reads
        # as shuffle, not triplets. Report-only for now: the score is
        # left as written and the issue tells the user to check.
        swing_est = detect_swing(
            tuple(n.onset_ql for n in normalized),
            Fraction(4, meter.denominator),
        )
        if swing_est.detected:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=TimeRange(
                        start_sec=0.0, end_sec=duration_sec
                    ),
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
        musicxml_concert = export_concert_musicxml(built.document)
        musicxml_horn = export_horn_in_f_musicxml(built.document)

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
                built.document, musicxml_concert, part_index=pi
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
                    time_range=TimeRange(
                        start_sec=0.0, end_sec=duration_sec
                    ),
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
                "scoreDocument": built.document.to_dict(),
                "reviewIssues": [i.to_dict() for i in issues],
                "musicXmlConcert": musicxml_concert,
                "musicXmlHornF": musicxml_horn,
                "meta": {
                    "backend": "basic_pitch",
                    "backendVersion": "0.4.0",
                    # #100: project.save needs the tr-* id for the
                    # TranscriptionRecord in .hornscribe.json.
                    "transcriptionRevision": str(revision),
                    "audioPath": params.audio_path,
                    "durationSec": round(duration_sec, 3),
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
