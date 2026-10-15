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

from bisect import bisect_left
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from hornscribe.domain.score import TempoSegment
from hornscribe.rhythm.beatmap import BeatAnchor, BeatMap, BeatSource
from hornscribe.rhythm.meter import MeterSegment
from hornscribe.rhythm.timewarp import TimeWarp

from .backend import require_module

# Merge adjacent tempo estimates differing by less than this ratio —
# beat-tracker jitter under ~2.5 % is not a real tempo change. The
# map's first job is reproducing the warp for onset mapping, so the
# threshold stays tight: a one-bar blip may print a redundant mark,
# which is cheaper than a merged constant that drifts off-warp.
_TEMPO_MERGE_RATIO = 0.025

# #231: a tempo mark is earned by PERSISTENT deviation — tracker
# re-phasing at phrase boundaries swings the per-measure estimate
# +-10 % for a bar or two and reverts, which is not a tempo change.
# A mark prints only when the new level holds _TEMPO_PERSIST_MEASURES
# straight, or the track ends on a clearly different tempo (a final
# rit. still counts).
_TEMPO_PERSIST_MEASURES = 4
_TEMPO_TAIL_JUMP_RATIO = 0.08
# Off-slope guard: when most intervals deviate >10 % from the
# regression line the track is genuinely multi-tempo, so the
# dominant median stays the primary tempo. Frame-quantisation
# jitter stays well under 10 % and never trips the guard.
_LSQ_OFF_SLOPE_RATIO = 0.10
_LSQ_MAX_OUTLIER_SHARE = 1.0 / 3.0
# #202 steady-track collapse: an anchor-level jitter floor. Per-
# measure tempo on a quantised beat track swings +-10-15 % even on a
# metronomic song (one-frame anchor noise amplified over a 2-4 beat
# span), so measure-BPM thresholds alone cannot tell "steady" from
# "moving". Anchor residuals against the global LSQ line can: tracked
# beats on a steady pulse sit within ~1-2 hops of the line, while a
# real rit./step accumulates drift far past the floor. Mean < 8 % of
# the median interval AND max < 40 % (a dropped/doubled anchor is a
# genuine track defect, not "steady") collapses the map to one mark.
_STEADY_MIN_ANCHORS = 8
_STEADY_MEAN_RESID_FRAC = 0.08
_STEADY_MAX_RESID_FRAC = 0.40
# #199: a sustained one-direction drift (rit./accel.) defeats the
# episode model -- EVERY measure is a fresh out-of-corridor level, so
# persistence emits a staircase one corridor wide and the printed map
# lags the warp by whole beats (rubato-4-4 scored onset F1 0.59 with
# a 133 ms axis error). When the pending run keeps stepping the same
# direction at ramp scale -- a bigger step is a discrete tempo CHANGE,
# not a drift -- emit every drifting measure's own rate and keep
# emitting per-measure while the drift continues.
_TEMPO_RAMP_STEP_RATIO = 0.015
_TEMPO_RAMP_MAX_STEP = 0.15
# A corridor-flat measure does not declare the drift over (a rit.
# that pauses a bar is still a rit.) — but more than this many
# straight pause measures does.
_TEMPO_RAMP_IDLE_MEASURES = 2


def _anchor_slope_sec(times: tuple[float, ...]) -> float | None:
    """Least-squares seconds-per-anchor over the tracked beats.

    Whole-frame quantization makes every interval on a regular
    pulse report the same integer hop count, so a median of
    intervals inherits a ~2 % bias (129.2 bpm of a true 132).
    The regression slope uses every anchor at once and cancels
    it. Returns None for < 3 anchors or a non-positive slope.
    """
    n = len(times)
    if n < 3:
        return None
    xbar = (n - 1) / 2.0
    ybar = sum(times) / n
    var = sum((i - xbar) ** 2 for i in range(n))
    if var == 0:
        return None
    slope = sum((i - xbar) * (t - ybar) for i, t in enumerate(times)) / var
    return slope if slope > 0 else None


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
    candidate) — the phase-grid index, internal bookkeeping only.
    ``pickup_ql`` is the implied anacrusis length in exact quarter
    units: the unit-safe form for comparisons and for the setPickup
    remedy (#276). ``downbeat_score`` is the mean normalized onset
    strength at the beats that phase would make barlines; without
    beat strengths every candidate reports the neutral 0.5 and the
    margin logic stays silent.
    """

    pickup_beats: int
    pickup_ql: Fraction
    downbeat_score: float
    accomp_score: float | None = None
    """#150: normalized onset-mass share of the separated
    accompaniment part at this phase (1.0 = a uniform spread across
    beats, None = no accompaniment evidence). A second, independent
    accent source: the stem envelope can sit flat on a
    four-on-the-floor mix while the bass/chord attacks still mark
    the barline."""


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
    canonical_beat_ql: Fraction
    """#276: the ScoreEdit beat unit (4/denominator) — the unit
    inferred/suggested beats are reported and applied in."""
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
    phase_accents: tuple[tuple[float, float], ...] | None = None,
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
    ambiguity analysis (#358). ``phase_accents`` adds a second,
    independent phase source: (onset_sec, post-onset RMS) pairs from
    the separated accompaniment part, bucketed onto the nearest
    tracked beat (#150). Only the auto path reads it — a pinned
    tempo never inferred a pickup.
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
            # land the earliest grid point on the onset itself. The
            # spacing is the LOCAL interval at the track boundary
            # (median of the first few tracked IBIs), not the global
            # median — on a rit./accel. the early beats run at the
            # piece's fastest tempo and a global median lands every
            # synthesized anchor tens of ms off (rubato-4-4).
            local = [d for d in intervals[:4]]
            local_sec = (
                sorted(local)[len(local) // 2] if local else median_sec
            )
            n_missing = int(gap / local_sec + 0.5)
            for k in range(n_missing, 0, -1):
                if k == n_missing:
                    leading_beats.append(float(first_onset_sec))
                else:
                    leading_beats.append(
                        float(first_onset_sec) + (n_missing - k) * local_sec
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
    # LSQ over the anchor row fixes the whole-frame quantization bias
    # a median of intervals keeps (~2 % on a steady pulse). A track
    # with genuinely two tempos shows >10 % off-slope intervals all
    # over — the outlier-share guard keeps the dominant median there
    # while pure quantisation jitter (well under 10 %) cannot trip it.
    slope_sec = _anchor_slope_sec(beat_times)
    if slope_sec is not None and intervals:
        outliers = sum(
            1
            for d in intervals
            if abs(d - slope_sec) / slope_sec > _LSQ_OFF_SLOPE_RATIO
        )
        if outliers <= len(intervals) * _LSQ_MAX_OUTLIER_SHARE:
            median_bpm = (
                float(beat_unit_ql)
                * 60.0
                / (slope_sec * float(meter.beat_unit_ql))
            )
    # #358: keep the inference evidence — the pipeline decides whether
    # this pickup was confident enough to write silently.
    pickup_analysis = _build_pickup_analysis(
        all_beats=all_beats,
        all_strengths=all_strengths,
        phase_accents=phase_accents,
        first_onset_sec=first_onset_sec,
        first_tracked_beat_sec=first_tracked_beat_sec,
        median_interval_sec=median_sec,
        leading_beats_added=len(leading_beats),
        first_ql=first_ql,
        beat_unit_ql=beat_unit_ql,
        measure_ql=measure_ql,
        # #276: canonical ScoreEdit beats (4/denominator) are the
        # report/apply unit — the tracked pulse can sit a level
        # below (eighths under a compound-beat meter read).
        canonical_beat_ql=Fraction(4, meter.denominator),
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
# #150: the accompaniment phase channel is "confident" when its best
# bucket clearly beats a uniform spread (score 1.0) AND clearly beats
# the runner-up — a bass hit on every barline reads ~2.4 while a
# wandering melodic line stays near the uniform floor.
_ACCOMP_PHASE_MIN_SCORE = 1.5
_ACCOMP_PHASE_MIN_MARGIN = 0.5


def _beats_num(beats: Fraction) -> int | float:
    """Beat count as a JSON-friendly number — int when whole, float
    for fractional (half-beat) spans (#276)."""
    return int(beats) if beats.denominator == 1 else float(beats)


def _canonical_num(
    candidate: PickupCandidate, analysis: PickupAnalysis
) -> int | float:
    """A candidate's implied anacrusis in canonical ScoreEdit beats."""
    return _beats_num(candidate.pickup_ql / analysis.canonical_beat_ql)


def _phase_accent_mass(
    all_beats: tuple[float, ...],
    accents: tuple[tuple[float, float], ...] | None,
    measure_beats: int,
) -> list[float] | None:
    """Normalized onset-mass share per beat-phase bucket (#150).

    Each (onset_sec, amplitude) accent votes into the phase bucket of
    its nearest tracked beat; the shares are scaled so a uniform
    spread reads 1.0 and a concentrated downbeat phase reads above 1.
    Returns ``None`` when there is nothing to distribute.
    """
    if not all_beats or not accents:
        return None
    mass = [0.0] * measure_beats
    last = len(all_beats) - 1
    for t, amp in accents:
        i = bisect_left(all_beats, t)
        if i > last:
            i = last
        elif i > 0 and t - all_beats[i - 1] <= all_beats[i] - t:
            i -= 1
        mass[i % measure_beats] += float(amp)
    total = sum(mass)
    if total <= 0:
        return None
    return [m / total * measure_beats for m in mass]


def _build_pickup_analysis(
    *,
    all_beats: tuple[float, ...],
    all_strengths: list[float],
    phase_accents: tuple[tuple[float, float], ...] | None = None,
    first_onset_sec: float | None,
    first_tracked_beat_sec: float | None,
    median_interval_sec: float,
    leading_beats_added: int,
    first_ql: Fraction | None,
    beat_unit_ql: Fraction,
    measure_ql: Fraction,
    canonical_beat_ql: Fraction,
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
        acc_mass = _phase_accent_mass(all_beats, phase_accents, mb)
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
            beats_j = (inferred_beats + j) % mb
            candidates.append(
                PickupCandidate(
                    pickup_beats=beats_j,
                    pickup_ql=Fraction(beats_j) * beat_unit_ql,
                    downbeat_score=round(score, 4),
                    accomp_score=(
                        round(acc_mass[j], 4)
                        if acc_mass is not None
                        else None
                    ),
                )
            )
    else:
        strength_available = False
    return PickupAnalysis(
        inferred_pickup_ql=inferred_pickup_ql,
        inferred_pickup_beats=Fraction(
            inferred_pickup_ql / canonical_beat_ql
        ),
        canonical_beat_ql=canonical_beat_ql,
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

    #276: all beats reported/applied here are CANONICAL ScoreEdit
    beats (4/denominator) — the tracked pulse can sit a level below
    (eighths under a compound-meter read), and comparing or applying
    pulse counts directly wrote the wrong pickup length.
    """
    a = estimate.pickup_analysis
    if a is None:
        return None
    inferred_ql = a.inferred_pickup_ql
    flags: list[str] = []
    suggested: int | float | None = None
    ranked = sorted(
        a.candidates, key=lambda c: -c.downbeat_score
    )
    current = next(
        (c for c in a.candidates if c.pickup_ql == inferred_ql),
        None,
    )
    # #150: the accompaniment part's onset phase is a second, much
    # stronger downbeat source than the (often flat) stem envelope —
    # when it concentrates on one phase its read outranks the
    # envelope's and settles the question the envelope raised.
    acc_ranked = sorted(
        (c for c in a.candidates if c.accomp_score is not None),
        key=lambda c: -(c.accomp_score or 0.0),
    )
    acc_pick: PickupCandidate | None = None
    if len(acc_ranked) >= 2:
        best_acc, runner_acc = acc_ranked[0], acc_ranked[1]
        if (
            (best_acc.accomp_score or 0.0) >= _ACCOMP_PHASE_MIN_SCORE
            and (best_acc.accomp_score or 0.0)
            - (runner_acc.accomp_score or 0.0)
            >= _ACCOMP_PHASE_MIN_MARGIN
        ):
            acc_pick = best_acc
    if acc_pick is not None:
        if acc_pick.pickup_ql != inferred_ql:
            env_pick: PickupCandidate | None = None
            if (
                a.strength_available
                and len(ranked) >= 2
                and ranked[0].downbeat_score - ranked[1].downbeat_score
                >= _PICKUP_PHASE_MARGIN
            ):
                env_pick = ranked[0]
            if (
                env_pick is not None
                and env_pick.pickup_ql != acc_pick.pickup_ql
            ):
                # Two strong sources prefer two different phases —
                # genuinely undecidable; report the stronger guess.
                flags.append("downbeat_phase_ambiguous")
            else:
                flags.append("downbeat_phase_mismatch")
            suggested = _canonical_num(acc_pick, a)
        # When the stronger channel confirms the written phase the
        # flat envelope's read is noise, not a conflict — stay silent.
    elif a.strength_available and len(ranked) >= 2:
        best, runner_up = ranked[0], ranked[1]
        margin = best.downbeat_score - runner_up.downbeat_score
        current_score = current.downbeat_score if current else 0.0
        if (
            best.pickup_ql != inferred_ql
            and best.downbeat_score - current_score >= _PICKUP_PHASE_MARGIN
        ):
            flags.append("downbeat_phase_mismatch")
            suggested = _canonical_num(best, a)
        elif margin < _PICKUP_PHASE_MARGIN:
            flags.append("downbeat_phase_ambiguous")
            if best.pickup_ql != inferred_ql:
                suggested = _canonical_num(best, a)
    # A hairline-early onset producing a pickup is the classic
    # phantom anacrusis — tracker jitter is just as plausible.
    if (
        inferred_ql > 0
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
        "inferredPickupBeats": _beats_num(a.inferred_pickup_beats),
        "suggestedPickupBeats": suggested,
        "flags": flags,
        "candidates": [
            {
                # Canonical beats — the unit the pickup field and
                # setPickup speak (#276).
                "pickupBeats": _beats_num(
                    c.pickup_ql / a.canonical_beat_ql
                ),
                "downbeatScore": c.downbeat_score,
                "accompScore": c.accomp_score,
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
    *,
    last_onset_sec: float | None = None,
) -> tuple[TempoSegment, ...]:
    """Derive the score's tempo map (primary-beat BPM per measure).

    Fixed/manual runs get a single segment at beat 0. Tracked runs emit
    one segment per measure boundary whose instantaneous tempo differs
    from the running value by more than ~2 %, so rit./accel. survive
    without one tempo mark per beat. #202: a track whose anchors hug
    one straight line (real-world jitter on a metronomic song) prints
    ONE mark — per-measure tempo on such a track swings +-15 % from
    frame quantisation alone and used to spam a mark per bar.
    """
    if not estimate.auto or len(estimate.beat_times_sec) < 2:
        # #249: tracked tempo prints as an integer mark like every
        # other path (false precision otherwise); a pinned manual
        # tempo is the user's own word and prints as entered.
        return (
            TempoSegment(
                start_beat=Fraction(0),
                bpm=(
                    float(round(estimate.median_bpm))
                    if estimate.auto
                    else float(estimate.median_bpm)
                ),
            ),
        )

    # The exported BPM must be in primary-beat units (midi.py divides
    # by meter.beat_unit): the ql-space rate below converts directly
    # through beat_unit_ql, so the tracked pulse unit needs no
    # separate handling.
    beat_unit = meter.beat_unit_ql
    times = estimate.beat_times_sec
    beat_ql = Fraction(4, meter.denominator)
    # #202: steady-track collapse — judge the anchors, not the derived
    # measure rates. LSQ residuals at the beat level stay inside the
    # tracker's own noise floor on a metronomic song; anything that
    # drifts or steps leaves far bigger residuals.
    slope = _anchor_slope_sec(times)
    if slope is not None and len(times) >= _STEADY_MIN_ANCHORS:
        xbar = (len(times) - 1) / 2.0
        ybar = sum(times) / len(times)
        intercept = ybar - slope * xbar
        residuals = [
            abs(t - (intercept + slope * i)) for i, t in enumerate(times)
        ]
        intervals_sec = [
            b - a for a, b in zip(times, times[1:], strict=False) if b > a
        ]
        if intervals_sec:
            med = sorted(intervals_sec)[len(intervals_sec) // 2]
            mean_resid = sum(residuals) / len(residuals)
            if (
                med > 0
                and mean_resid <= _STEADY_MEAN_RESID_FRAC * med
                and max(residuals) <= _STEADY_MAX_RESID_FRAC * med
            ):
                # Marks read like a conductor's metronome — integer BPM.
                return (
                    TempoSegment(
                        start_beat=Fraction(0),
                        bpm=float(round(estimate.median_bpm)),
                    ),
                )
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

    def measure_bounds_ql(index: int) -> tuple[Fraction, Fraction]:
        a = meter.start_ql + index * measure_len_ql - phase_ql
        b = meter.start_ql + (index + 1) * measure_len_ql - phase_ql
        return max(Fraction(0), a), b

    # Per-measure tempo = the warp's own local rate between the
    # measure's ql bounds: ql_span / sec_span through the piecewise-
    # linear beat map. The map then agrees with the warp at every
    # barline by construction — no boundary drift — and each inside
    # position interpolates within one interval. A median-of-
    # intervals inherits frame-quantisation bias (~2 % on a 0.42 s
    # beat); a 4-anchor LSQ swung ~5 %/bar on sub-frame-refined
    # anchors (tempo-step bench).
    measure_bpm: dict[int, float] = {}
    first_m = measure_index(estimate.warp.seconds_to_ql(times[0]))
    last_m = measure_index(estimate.warp.seconds_to_ql(times[-1]))
    # Beat anchors keep ticking into the decay tail, so last_m can land
    # one measure past the music. A tempo mark on a measure with no
    # onsets describes nothing — and its tail-extrapolated rate can
    # swallow a genuine mid-piece step via the episode's emit_pos scan
    # (bench tempo-step-4-4 printed {0: 99, 16: 154} instead of
    # {0: 99, 8: 140}). Clamp emission to the last onset's measure.
    if last_onset_sec is not None:
        last_m = min(
            last_m,
            measure_index(estimate.warp.seconds_to_ql(last_onset_sec)),
        )
    # #133: a measure's printed rate must come from MUSIC, not the
    # tracker's head/tail extrapolation — bound each measure's rate
    # span to the measured range.  The head bound is the first anchor;
    # the tail bound is the last onset when the caller knows it (the
    # final inter-anchor tick is the tracker's own extrapolation and
    # used to drag the last mark off the settled level — tempo-step's
    # closing measure printed ~146 for a true 140).  A measure left
    # with under half a beat of measured span emits nothing: a mark
    # there would describe extrapolation, and the previous episode's
    # rate continuing to the piece's end is the honest read.
    ql_head = estimate.warp.seconds_to_ql(times[0])
    ql_tail = estimate.warp.seconds_to_ql(times[-1])
    if last_onset_sec is not None:
        ql_tail = min(
            ql_tail, estimate.warp.seconds_to_ql(last_onset_sec)
        )
        # #199: measure tempo only through anchors at or before the
        # last onset -- the tracker ticks past the music at an
        # invented tail rate, and interpolating inside that phantom
        # interval drags the closing measure's mark off the settled
        # level (tempo-step's tail anchor pushed the last measure
        # toward ~146-161 for a true 140).
        for t in reversed(times):
            if t <= last_onset_sec + 1e-6:
                ql_tail = min(ql_tail, estimate.warp.seconds_to_ql(t))
                break
        else:
            ql_tail = ql_head
    for index in range(first_m, last_m + 1):
        a_ql, b_ql = measure_bounds_ql(index)
        a_ql = max(a_ql, ql_head)
        b_ql = min(b_ql, ql_tail)
        if b_ql <= a_ql:
            continue
        if b_ql - a_ql < beat_ql / 2:
            continue
        d_sec = estimate.warp.ql_to_seconds(
            b_ql
        ) - estimate.warp.ql_to_seconds(a_ql)
        if d_sec <= 0:
            continue
        measure_bpm[index] = (
            60.0
            * float(b_ql - a_ql)
            / (d_sec * float(beat_unit))
        )
    indices = sorted(measure_bpm)
    if not indices:
        return (
            TempoSegment(
                # #249: same integer-mark contract as the main path.
                start_beat=Fraction(0), bpm=float(round(estimate.median_bpm))
            ),
        )
    # #202: median-3 smooth the per-measure series before emitting —
    # a one-measure blip (tracker wobble, drummer fill) is not a tempo
    # change, but a sustained rit./step survives the window and still
    # lands on its measure boundary. Endpoints borrow the neighbour.
    smoothed: dict[int, float] = {}
    for pos, index in enumerate(indices):
        lo = (
            measure_bpm[indices[pos - 1]]
            if pos > 0
            else measure_bpm[index]
        )
        hi = (
            measure_bpm[indices[pos + 1]]
            if pos < len(indices) - 1
            else measure_bpm[index]
        )
        smoothed[index] = sorted((lo, measure_bpm[index], hi))[1]
    # The beat-0 segment inherits the FIRST measurable measure's tempo:
    # a pickup-only measure 0 (one anchor, no slope) must not split a
    # redundant mark off at the first downbeat. Printed BPM is an
    # integer — sub-unit precision on a tracked tempo is false
    # precision anyway (the warp keeps the real timing).
    segments: list[TempoSegment] = [
        TempoSegment(
            start_beat=Fraction(0),
            bpm=float(round(smoothed[indices[0]])),
        )
    ]
    last_bpm = smoothed[indices[0]]
    # #231: hysteresis by persistence — an episode is the contiguous run
    # of out-of-corridor measures in one direction; it prints (at its
    # onset measure) once it outlives _TEMPO_PERSIST_MEASURES, or when
    # the piece ends on it and the jump is unambiguous. Reverts inside
    # the corridor or a direction flip discard the pending episode.
    pending_pos: int | None = None
    pending_dir = 0
    ramp_dir = 0
    ramp_idle = 0
    last_pos = len(indices) - 1
    for pos in range(1, len(indices)):
        index = indices[pos]
        bpm = smoothed[index]
        dev = bpm - last_bpm
        if ramp_dir:
            # #199: mid-drift — each further measure at ramp scale in
            # the drift direction earns its own mark immediately. A
            # measure that merely pauses inside the merge corridor
            # does not end the drift (a rit. that breathes for a bar
            # is still a rit.); only a reversal or a step-sized jump
            # does. Up to _TEMPO_RAMP_IDLE_MEASURES corridor measures
            # may pass before the drift is declared over.
            step_ratio = dev / last_bpm if last_bpm else 0.0
            if (
                _TEMPO_MERGE_RATIO
                < step_ratio * ramp_dir
                <= _TEMPO_RAMP_MAX_STEP
            ):
                segments.append(
                    TempoSegment(
                        start_beat=measure_start_beats(index),
                        bpm=float(round(bpm)),
                    )
                )
                last_bpm = bpm
                pending_pos = None
                pending_dir = 0
                ramp_idle = 0
                continue
            if abs(step_ratio) <= _TEMPO_MERGE_RATIO:
                ramp_idle += 1
                if ramp_idle <= _TEMPO_RAMP_IDLE_MEASURES:
                    continue
            ramp_dir = 0
            ramp_idle = 0
        if abs(dev) / last_bpm <= _TEMPO_MERGE_RATIO:
            pending_pos = None
            pending_dir = 0
            continue
        direction = 1 if dev > 0 else -1
        if pending_pos is None or direction != pending_dir:
            pending_pos, pending_dir = pos, direction
        persisted = pos - pending_pos + 1 >= _TEMPO_PERSIST_MEASURES
        tail_jump = pos == last_pos and (
            abs(bpm - last_bpm) / last_bpm > _TEMPO_TAIL_JUMP_RATIO
        )
        if persisted or tail_jump:
            # #199: is the pending run a RAMP? A run that keeps
            # stepping the pending direction at ramp scale — at least
            # two in-band steps, no discrete jump, no reversal — is a
            # sustained rit./accel.: emit each drifting measure's own
            # rate instead of one mark at the far end. Trailing run
            # measures that stopped moving already sit at the new
            # level; the emit_pos path owns those.
            run = list(indices[pending_pos : pos + 1])
            end = len(run) - 1
            while end > 0 and abs(
                smoothed[run[end]] - smoothed[run[end - 1]]
            ) / smoothed[run[end - 1]] < _TEMPO_RAMP_STEP_RATIO:
                end -= 1
            trimmed = run[: end + 1]
            run_steps = [
                (smoothed[trimmed[q]] - smoothed[trimmed[q - 1]])
                / smoothed[trimmed[q - 1]]
                for q in range(1, len(trimmed))
            ]
            is_ramp = (
                len(trimmed) >= 3
                and len(
                    [
                        s
                        for s in run_steps
                        if _TEMPO_RAMP_STEP_RATIO
                        <= s * pending_dir
                        <= _TEMPO_RAMP_MAX_STEP
                    ]
                )
                >= 2
                and all(
                    s * pending_dir <= _TEMPO_RAMP_MAX_STEP
                    for s in run_steps
                )
                and all(
                    s * pending_dir >= -_TEMPO_RAMP_STEP_RATIO
                    for s in run_steps
                )
            )
            if is_ramp:
                for q in trimmed:
                    q_bpm = smoothed[q]
                    if (
                        abs(q_bpm - last_bpm) / last_bpm
                        <= _TEMPO_MERGE_RATIO
                    ):
                        continue
                    segments.append(
                        TempoSegment(
                            start_beat=measure_start_beats(q),
                            bpm=float(round(q_bpm)),
                        )
                    )
                    last_bpm = q_bpm
                ramp_dir = pending_dir
            else:
                # The mark belongs at the first measure already AT the
                # new level -- a boundary-crossing step starts its
                # episode on the mixed transition measure, so onset
                # != settle. The corridor uses the tail-jump scale
                # (8 %): the tight 2.5 % merge corridor rejected
                # genuinely-settled first measures under tracker
                # settling lag (~4-5 % noise) and jumped the mark a
                # whole measure late (bench tempo-step printed the
                # step at beat 12 instead of beat 8).
                emit_pos = pos
                for q in range(pending_pos, pos + 1):
                    q_bpm = smoothed[indices[q]]
                    if abs(q_bpm - bpm) / bpm <= _TEMPO_TAIL_JUMP_RATIO:
                        emit_pos = q
                        break
                segments.append(
                    TempoSegment(
                        start_beat=measure_start_beats(indices[emit_pos]),
                        bpm=float(round(bpm)),
                    )
                )
                last_bpm = bpm
            pending_pos = None
            pending_dir = 0
    return tuple(segments)
