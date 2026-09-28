"""Beat tracking -> TimeWarp and tempo map (ENG-002, design sections 6/29).

Two paths:

* ``tempo_bpm`` pinned (manual): ``TimeWarp.fixed_bpm`` — the beat grid
  is a straight line; ``zero_sec`` is set to the first detected onset so
  score position 0 lands on the first note, not on the file's t=0
  (otherwise a leading silence becomes leading rests).
* automatic: ``librosa.beat.beat_track`` anchors ->
  ``TimeWarp.from_beat_map`` — piecewise-linear warp that follows tempo
  drift (rit./accel.), which is exactly what a fixed grid cannot.

Beat anchors are mapped ``beat_i -> i * beat_unit_ql + shift`` where
``shift`` lifts the whole anchor row by whole beat units when the first
detected onset would otherwise land before score position 0 — the
common pickup/anacrusis case. The shift amount becomes the pickup
length (``measure_phase_ql`` on the meter segment, see scorebuild), so
the first tracked beat stays the first downbeat.

The tempo map for the exported score is derived from adjacent-anchor
instantaneous tempo, one :class:`TempoSegment` per measure boundary,
with sub-2 % jitter merged so the printed score gets a clean tempo map
instead of per-beat noise.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from hornscribe.domain.score import TempoSegment
from hornscribe.rhythm.beatmap import BeatAnchor, BeatMap, BeatSource
from hornscribe.rhythm.meter import MeterSegment
from hornscribe.rhythm.timewarp import TimeWarp

from .backend import require_module

# Merge adjacent tempo estimates differing by less than this ratio —
# beat-tracker jitter under ~2 % is not a real tempo change.
_TEMPO_MERGE_RATIO = 0.02


@dataclass(frozen=True)
class TempoEstimate:
    """Warp + estimated tempo facts for one transcription run."""

    warp: TimeWarp
    beat_times_sec: tuple[float, ...]
    """Detected beat anchor times (empty for the fixed-BPM path)."""
    median_bpm: float
    """Primary-beat BPM (median inter-beat interval, or the manual value)."""
    auto: bool
    """True when the tempo came from tracking, False when user-pinned."""
    pickup_len_ql: Fraction = Fraction(0)
    """Anacrusis span before the first downbeat (0 = no pickup)."""
    pulse_unit_ql: Fraction | None = None
    """Grid unit each tracked beat anchors (None = meter.beat_unit_ql)."""
    pickup_analysis: PickupAnalysis | None = None
    """#358: downbeat-phase evidence behind pickup_len_ql (None for
    the pinned/short-track paths, where no inference happened)."""


@dataclass(frozen=True)
class PickupCandidate:
    """#358: one alternative anacrusis length, scored by accent evidence.

    ``pickup_beats`` counts tracked-pulse units before beat 0 (the
    first tracked beat stays the first downbeat under every
    candidate). ``downbeat_score`` is the mean normalized onset
    strength at the beats that phase would make barlines; without
    beat strengths every candidate reports the neutral 0.5 and the
    margin logic stays silent.
    """

    pickup_beats: int
    downbeat_score: float


@dataclass(frozen=True)
class PickupAnalysis:
    """#358: the evidence behind the inferred measure phase.

    The pickup lift is a heuristic over the first-onset/beat-0 gap —
    this keeps the inputs and the phase-candidate scores so the
    pipeline can emit ``pickup_uncertain`` with traceable evidence
    instead of silently confirming a guess.
    """

    inferred_pickup_ql: Fraction
    inferred_pickup_beats: Fraction
    """Same span in canonical beat units (the ScoreEdit unit)."""
    first_onset_sec: float | None
    first_beat_sec: float | None
    """First tracked beat (before leading-beat synthesis)."""
    median_interval_sec: float
    leading_beats_added: int
    onset_phase_in_beat: float | None
    """First onset's position inside its beat cell, 0..1 (None when
    the onset could not be measured). A mid-cell onset makes the
    anacrusis reading ambiguous against syncopation/tracker offset."""
    candidates: tuple[PickupCandidate, ...]
    """Phase candidates 0..measure-1 beats, best-downbeat-score first."""
    strength_available: bool


def estimate_tempo(
    samples: Any,
    sample_rate: int,
    meter: MeterSegment,
    *,
    tempo_bpm: float | None,
    first_onset_sec: float | None,
    beat_times: tuple[float, ...] | None = None,
    pulse_unit_ql: Fraction | None = None,
    beat_strengths: tuple[float, ...] | None = None,
) -> TempoEstimate:
    """Build the seconds->ql warp for this run.

    ``first_onset_sec`` anchors the fixed-BPM path and the beat-map
    alignment shift; pass ``None`` for an empty event list (the warp is
    then anchored at t=0 and the score will be empty anyway).

    ``beat_times`` reuses an already-computed beat track (the pipeline
    needs it for meter estimation first); ``pulse_unit_ql`` overrides
    ``meter.beat_unit_ql`` as the grid unit each tracked beat anchors —
    auto-detected 6/8 tracks eighths, not dotted quarters.
    ``beat_strengths`` is the parallel onset-envelope sample per
    ``beat_times`` entry — downbeat-phase evidence for the pickup
    ambiguity analysis (#358).
    """
    beat_unit_ql = pulse_unit_ql if pulse_unit_ql is not None else meter.beat_unit_ql
    if tempo_bpm is not None:
        # Manual tempo: bpm counts *primary beats* per minute, so the
        # quarterLength rate is bpm * beat_unit_ql / 60.
        quarter_bpm = tempo_bpm * float(beat_unit_ql)
        warp = TimeWarp.fixed_bpm(
            bpm=quarter_bpm, zero_sec=first_onset_sec or 0.0
        )
        return TempoEstimate(
            warp=warp,
            beat_times_sec=(),
            median_bpm=float(tempo_bpm),
            auto=False,
        )

    if beat_times is None:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency

        _tempo, beat_frames = librosa.beat.beat_track(
            y=samples, sr=sample_rate, units="frames"
        )
        # BeatMap requires strictly increasing times; drop dupes/zeros.
        beat_times_list: list[float] = []
        for t in librosa.frames_to_time(beat_frames, sr=sample_rate):
            ft = float(t)
            if not beat_times_list or ft > beat_times_list[-1]:
                beat_times_list.append(ft)
        beat_times = tuple(beat_times_list)
    if len(beat_times) < 2:
        # Tracking found no usable pulse — fall back to a conservative
        # fixed grid anchored on the first onset rather than failing.
        warp = TimeWarp.fixed_bpm(bpm=120.0, zero_sec=first_onset_sec or 0.0)
        return TempoEstimate(
            warp=warp, beat_times_sec=(), median_bpm=120.0, auto=True
        )

    intervals = [b - a for a, b in zip(beat_times, beat_times[1:], strict=False)]
    intervals = [d for d in intervals if d > 0]
    median_sec = sorted(intervals)[len(intervals) // 2] if intervals else 0.5

    # The tracker often drops the very first beat (it prefers a settled
    # pulse over the attack at t=0). When the first onset sits roughly
    # one interval before beat 0, prepend a synthesized beat at the
    # onset — otherwise the real downbeat gets misread as a pickup.
    # #358: strengths stay index-aligned with beat_times through the
    # mutations below — synthesized leading beats get the neutral
    # median, the snapped-away beat drops its strength too.
    first_tracked_beat_sec = beat_times[0] if beat_times else None
    strengths: list[float] = (
        [float(s) for s in beat_strengths[: len(beat_times)]]
        if beat_strengths is not None
        else []
    )
    leading_beats: list[float] = []
    if first_onset_sec is not None:
        gap = beat_times[0] - first_onset_sec
        if 0.55 * median_sec <= gap < 1.5 * median_sec:
            leading_beats.append(float(first_onset_sec))
        elif 0.02 < gap < 0.55 * median_sec:
            # Beat 0 sits a fraction of a pulse after the first onset:
            # the tracker landed late on the same downbeat — snap the
            # anchor to the onset so the first note is not a phantom
            # pickup.
            leading_beats.append(float(first_onset_sec))
            beat_times = beat_times[1:]
            if strengths:
                strengths = strengths[1:]
        elif gap >= 1.5 * median_sec:
            # Multiple missing beats: walk back on the median grid and
            # land the earliest grid point on the onset itself.
            n_missing = int(gap / median_sec + 0.5)
            for k in range(n_missing, 0, -1):
                if k == n_missing:
                    leading_beats.append(float(first_onset_sec))
                else:
                    leading_beats.append(
                        float(first_onset_sec) + (n_missing - k) * median_sec
                    )
    all_beats = tuple(leading_beats) + beat_times
    neutral_strength = (
        sorted(strengths)[len(strengths) // 2] if strengths else 0.5
    )
    all_strengths = (
        [neutral_strength] * len(leading_beats) + strengths
        if beat_strengths is not None
        else []
    )

    # Anchor beat i to score position i * beat_unit_ql, then lift the
    # whole row by whole beats when the first onset precedes beat 0 —
    # the lift is the pickup length (the first tracked beat stays the
    # first downbeat).
    shift_ql = Fraction(0)
    first_ql: Fraction | None = None
    if first_onset_sec is not None:
        # Provisional warp to measure the pre-beat-0 gap.
        probe = TimeWarp.from_beat_map(
            BeatMap(
                tuple(
                    BeatAnchor(
                        time_sec=t,
                        score_pos_ql=Fraction(i) * beat_unit_ql,
                        source=BeatSource.BEAT_TRACKER,
                    )
                    for i, t in enumerate(all_beats)
                )
            )
        )
        first_ql = probe.seconds_to_ql(first_onset_sec)
        if first_ql < 0:
            shift_ql = (-first_ql // beat_unit_ql + 1) * beat_unit_ql
    anchors = [
        BeatAnchor(
            time_sec=t,
            score_pos_ql=Fraction(i) * beat_unit_ql + shift_ql,
            source=BeatSource.BEAT_TRACKER,
        )
        for i, t in enumerate(all_beats)
    ]
    warp = TimeWarp.from_beat_map(BeatMap(tuple(anchors)))
    # Beat 0 lands at ql=shift_ql; the pickup measure is the last
    # (shift mod measure) beats before it. A whole-measure lift needs
    # no anacrusis (beat 0 is itself a downbeat).
    measure_ql = meter.measure_length_ql
    pickup_len = shift_ql % measure_ql

    # Report in primary-beat units (musician BPM): the tracked pulse
    # interval maps to one pulse_unit_ql of score time.
    median_bpm = (
        float(beat_unit_ql) * 60.0 / (median_sec * float(meter.beat_unit_ql))
    )
    # #358: keep the inference evidence — the pipeline decides whether
    # this pickup was confident enough to write silently.
    pickup_analysis = _build_pickup_analysis(
        all_beats=all_beats,
        all_strengths=all_strengths,
        first_onset_sec=first_onset_sec,
        first_tracked_beat_sec=first_tracked_beat_sec,
        median_interval_sec=median_sec,
        leading_beats_added=len(leading_beats),
        first_ql=first_ql,
        beat_unit_ql=beat_unit_ql,
        measure_ql=measure_ql,
        meter_beat_ql=meter.beat_unit_ql,
        inferred_pickup_ql=pickup_len,
    )
    return TempoEstimate(
        warp=warp,
        beat_times_sec=all_beats,
        median_bpm=median_bpm,
        auto=True,
        pickup_len_ql=pickup_len,
        pulse_unit_ql=pulse_unit_ql,
        pickup_analysis=pickup_analysis,
    )


# #358 uncertainty thresholds. The candidate-phase margin is a
# normalized accent-score difference; the onset-phase windows mark
# landings the heuristic cannot justify either way.
_PICKUP_PHASE_MARGIN = 0.10
_ONSET_JITTER_PHASE = 0.90
_ONSET_MID_BEAT_LO = 0.25
_ONSET_MID_BEAT_HI = 0.75


def _build_pickup_analysis(
    *,
    all_beats: tuple[float, ...],
    all_strengths: list[float],
    first_onset_sec: float | None,
    first_tracked_beat_sec: float | None,
    median_interval_sec: float,
    leading_beats_added: int,
    first_ql: Fraction | None,
    beat_unit_ql: Fraction,
    measure_ql: Fraction,
    meter_beat_ql: Fraction,
    inferred_pickup_ql: Fraction,
) -> PickupAnalysis:
    """Score the downbeat-phase candidates behind the inferred pickup.

    Candidate ``j`` reads beats ``j, j+mb, j+2mb...`` as the downbeats
    (the inference assumes ``j == 0``). Its implied anacrusis is
    ``(inferred + j) mod mb`` beats; its score is the mean normalized
    onset strength at those beat positions — an accent phase the
    tracker cannot name is exactly the ambiguity a reviewer should
    see. Non-integral measure lengths skip phase scoring entirely.
    """
    mb_frac = measure_ql / beat_unit_ql
    inferred_beats = int(inferred_pickup_ql / beat_unit_ql)
    onset_phase: float | None = None
    if first_ql is not None:
        onset_phase = float(
            (first_ql % beat_unit_ql) / beat_unit_ql
        )
    candidates: list[PickupCandidate] = []
    strength_available = (
        len(all_strengths) == len(all_beats) and bool(all_strengths)
    )
    if mb_frac.denominator == 1 and mb_frac >= 1:
        mb = int(mb_frac)
        peak = max(all_strengths) if all_strengths else 1.0
        norm = peak if peak > 0 else 1.0
        for j in range(mb):
            idx = [i for i in range(len(all_beats)) if i % mb == j]
            if strength_available:
                score = (
                    sum(all_strengths[i] for i in idx) / (len(idx) * norm)
                    if idx
                    else 0.0
                )
            else:
                score = 0.5
            candidates.append(
                PickupCandidate(
                    pickup_beats=(inferred_beats + j) % mb,
                    downbeat_score=round(score, 4),
                )
            )
    else:
        strength_available = False
    return PickupAnalysis(
        inferred_pickup_ql=inferred_pickup_ql,
        inferred_pickup_beats=Fraction(inferred_pickup_ql / meter_beat_ql),
        first_onset_sec=first_onset_sec,
        first_beat_sec=first_tracked_beat_sec,
        median_interval_sec=median_interval_sec,
        leading_beats_added=leading_beats_added,
        onset_phase_in_beat=onset_phase,
        candidates=tuple(candidates),
        strength_available=strength_available,
    )


def pickup_uncertainty(estimate: TempoEstimate) -> dict[str, Any] | None:
    """#358: is the inferred anacrusis ambiguous enough to review?

    Returns the ReviewIssue evidence dict (None = confident). Fires
    when accent evidence prefers a different downbeat phase, when the
    phase candidates tie, when a hairline-early onset forced a
    whole-beat pickup, or when the first onset lands mid-beat (the
    anacrusis/offbeat-entrance readings cannot be told apart).
    """
    a = estimate.pickup_analysis
    if a is None:
        return None
    inferred_beats = int(a.inferred_pickup_beats)
    flags: list[str] = []
    suggested: int | None = None
    ranked = sorted(
        a.candidates, key=lambda c: -c.downbeat_score
    )
    current = next(
        (c for c in a.candidates if c.pickup_beats == inferred_beats),
        None,
    )
    if a.strength_available and len(ranked) >= 2:
        best, runner_up = ranked[0], ranked[1]
        margin = best.downbeat_score - runner_up.downbeat_score
        current_score = current.downbeat_score if current else 0.0
        if (
            best.pickup_beats != inferred_beats
            and best.downbeat_score - current_score >= _PICKUP_PHASE_MARGIN
        ):
            flags.append("downbeat_phase_mismatch")
            suggested = best.pickup_beats
        elif margin < _PICKUP_PHASE_MARGIN:
            flags.append("downbeat_phase_ambiguous")
            if best.pickup_beats != inferred_beats:
                suggested = best.pickup_beats
    # A hairline-early onset producing a whole-beat pickup is the
    # classic phantom anacrusis — tracker jitter is just as plausible.
    if (
        inferred_beats > 0
        and a.onset_phase_in_beat is not None
        and a.onset_phase_in_beat >= _ONSET_JITTER_PHASE
    ):
        flags.append("hairline_onset")
        suggested = 0
    # A mid-beat onset reads equally well as a syncopated entrance or
    # an offbeat pickup the phase grid cannot name.
    if (
        a.onset_phase_in_beat is not None
        and _ONSET_MID_BEAT_LO <= a.onset_phase_in_beat <= _ONSET_MID_BEAT_HI
    ):
        flags.append("offbeat_onset")
    if not flags:
        return None
    return {
        "inferredPickupBeats": inferred_beats,
        "suggestedPickupBeats": suggested,
        "flags": flags,
        "candidates": [
            {
                "pickupBeats": c.pickup_beats,
                "downbeatScore": c.downbeat_score,
            }
            for c in a.candidates
        ],
        "firstOnsetSec": round(a.first_onset_sec, 4)
        if a.first_onset_sec is not None
        else None,
        "firstTrackedBeatSec": round(a.first_beat_sec, 4)
        if a.first_beat_sec is not None
        else None,
        "medianBeatIntervalSec": round(a.median_interval_sec, 4),
        "leadingBeatsAdded": a.leading_beats_added,
        "onsetPhaseInBeat": round(a.onset_phase_in_beat, 3)
        if a.onset_phase_in_beat is not None
        else None,
        "downbeatStrengthUsed": a.strength_available,
    }


def tempo_map_from_estimate(
    estimate: TempoEstimate,
    meter: MeterSegment,
) -> tuple[TempoSegment, ...]:
    """Derive the score's tempo map (primary-beat BPM per measure).

    Fixed/manual runs get a single segment at beat 0. Tracked runs emit
    one segment per measure boundary whose instantaneous tempo differs
    from the running value by more than ~2 %, so rit./accel. survive
    without one tempo mark per beat.
    """
    if not estimate.auto or len(estimate.beat_times_sec) < 2:
        return (TempoSegment(start_beat=Fraction(0), bpm=round(estimate.median_bpm, 2)),)

    # Tracked anchors sit on the *pulse* unit (eighths for auto-6/8);
    # the exported BPM must be in primary-beat units (midi.py divides
    # by meter.beat_unit), so convert through the ql ratio.
    pulse_unit = (
        estimate.pulse_unit_ql
        if estimate.pulse_unit_ql is not None
        else meter.beat_unit_ql
    )
    beat_unit = meter.beat_unit_ql
    times = estimate.beat_times_sec
    beat_ql = Fraction(4, meter.denominator)
    # #248: aggregate instantaneous tempo per MEASURE before emitting —
    # beat-tracker jitter inside a measure is not a tempo change. The
    # pickup measure is index 0 (span [0, pickup)); full measures tile
    # from pickup_ql, matching the measure_starts layout in pipeline.py.
    measure_len_ql = meter.measure_length_ql
    # MeterSegment.measure_index already implements the pickup-aware
    # layout (phase -> the short first measure is index 0). When the
    # caller passed a phase-less meter but the estimate carries a
    # pickup, derive the phase from it so bucketing still matches the
    # score's measure grid.
    phase_ql = meter.measure_phase_ql
    if not phase_ql and estimate.pickup_len_ql:
        phase_ql = (measure_len_ql - estimate.pickup_len_ql) % measure_len_ql

    def measure_index(pos_ql: Fraction) -> int:
        return int((pos_ql - meter.start_ql + phase_ql) // measure_len_ql)

    def measure_start_beats(index: int) -> Fraction:
        ql = meter.start_ql + index * measure_len_ql - phase_ql
        return max(Fraction(0), ql) / beat_ql

    # Least-squares slope of the anchors inside each measure. A median
    # of per-interval bpms inherits the frame-quantisation bias of the
    # tracker (~2% on a 0.42 s beat = 140->143.5 bpm), while the slope
    # averages the whole measure's anchors at once (#93). Bucket by the
    # measure containing each anchor's ql position (from the warp's
    # beat map, which already carries the pickup shift).
    measure_anchors: dict[int, list[tuple[float, float]]] = {}
    for i, t in enumerate(times):
        pos_ql = estimate.warp.seconds_to_ql(t)
        measure_anchors.setdefault(measure_index(pos_ql), []).append(
            (float(i), t)
        )
    # One value per measure; a segment is emitted only when the
    # measure's tempo differs from the last EMITTED value by more than
    # the merge ratio — a genuine rit./accel. survives as a stair-step
    # across measure boundaries.
    measure_bpm: dict[int, float] = {}
    for index, pts in measure_anchors.items():
        if len(pts) < 2:
            # A lone anchor has no slope and no tempo evidence of its
            # own — leave the neighbouring measures to carry it. The
            # pickup measure typically holds just the anacrusis beat.
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        xbar = sum(xs) / len(xs)
        ybar = sum(ys) / len(ys)
        var = sum((x - xbar) ** 2 for x in xs)
        slope = (
            sum((x - xbar) * (y - ybar) for x, y in pts) / var
            if var > 0
            else 0.0
        )
        measure_bpm[index] = (
            float(pulse_unit) * 60.0 / (slope * float(beat_unit))
            if slope > 0
            else float(estimate.median_bpm)
        )
    indices = sorted(measure_bpm)
    if not indices:
        return (
            TempoSegment(
                start_beat=Fraction(0), bpm=round(estimate.median_bpm, 2)
            ),
        )
    # The beat-0 segment inherits the FIRST measurable measure's tempo:
    # a pickup-only measure 0 (one anchor, no slope) must not split a
    # redundant mark off at the first downbeat.
    segments: list[TempoSegment] = [
        TempoSegment(start_beat=Fraction(0), bpm=round(measure_bpm[indices[0]], 2))
    ]
    last_bpm = measure_bpm[indices[0]]
    for index in indices[1:]:
        bpm = measure_bpm[index]
        if abs(bpm - last_bpm) / last_bpm > _TEMPO_MERGE_RATIO:
            segments.append(
                TempoSegment(
                    start_beat=measure_start_beats(index), bpm=round(bpm, 2)
                )
            )
            last_bpm = bpm
    return tuple(segments)
